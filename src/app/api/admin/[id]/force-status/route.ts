import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { syncBookingOT } from '@/lib/ot-sync'
import { startOfTodayBangkok } from '@/lib/bangkok-day'
import type { BookingStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

// Admin override targets. CANCELLED is intentionally excluded — cancelling has
// side effects (calendar event + OT cleanup) that only the DELETE/cancel flow does.
const FORCEABLE: BookingStatus[] = ['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED']

/**
 * POST /api/admin/[id]/force-status  { status, note? }
 *
 * Admin escape hatch: set BookingStatus directly, BYPASSING the normal transition
 * whitelist (booking-status.ts) and the shoot-date guard. For un-sticking bookings —
 * e.g. a shoot-day crew swap that bounced status, or a booking stuck in the wrong
 * state. Writes an AuditLog row (action booking.force_status) so the override is traceable.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await requireConsole()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const status = String(body?.status || '') as BookingStatus
    const note = body?.note ? String(body.note).trim().slice(0, 500) : null
    if (!FORCEABLE.includes(status)) {
      return NextResponse.json({ error: `Cannot force status to "${status}" (allowed: ${FORCEABLE.join(', ')})` }, { status: 400 })
    }

    const existing = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true, status: true, bookingCode: true, deletedAt: true, shootDate: true, shootEndDate: true,
        calendarEventId: true, calendarSyncStatus: true, calendarLastSyncedAt: true,
      },
    })
    if (!existing) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    if (existing.deletedAt) return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    // A CANCELLED booking is still accepted (prod behaviour — e.g. a shoot that
    // really happened after a mistaken cancel, forced to COMPLETED), but loudly:
    // only status + sheet + audit change, and the reply says what did NOT
    // (calendar, OT, room, cancel request). Whether to refuse CANCELLED here is
    // an open decision for Nat (maint 2026-11-08).
    const fromCancelled = existing.status === 'CANCELLED'
    if (existing.status === status) {
      return NextResponse.json({ ok: true, idempotent: true, booking: { id: existing.id, status } })
    }

    const shootNotPast = (existing.shootEndDate ?? existing.shootDate) >= startOfTodayBangkok()

    // CAS on the status we validated against (a concurrent cancel/auto-complete must not be overwritten)
    const cas = await prisma.booking.updateMany({
      where: { id: params.id, status: existing.status, deletedAt: null },
      data: {
        status,
        // v1.235 — force ไป CONFIRMED ก็ต้องรู้ว่าใครสั่ง (ดูคอมเมนต์ใน schema)
        // + stale PENDING = the reconciler's "create/verify this event" branch.
        // A never-approved row has calendarSyncStatus AND calendarLastSyncedAt
        // NULL, and the reconciler's NOT { PENDING, lastSynced >= 5 min ago }
        // is NULL for it in SQL → forced-CONFIRMED rows never got an event.
        // Only for a shoot whose last day is today or later: a re-opened PAST
        // shoot (e.g. COMPLETED → CONFIRMED) keeps prod behaviour — sync fields
        // untouched, so a never-synced one gets no event and no invites for a
        // date that has already gone.
        ...(status === 'CONFIRMED' ? { approvedAt: new Date(), approvedByEmail: session.email } : {}),
        ...(status === 'CONFIRMED' && !fromCancelled && shootNotPast
          ? { calendarSyncStatus: 'PENDING' as const, calendarSyncError: null, calendarLastSyncedAt: new Date(0) }
          : {}),
      },
    })
    if (cas.count === 0) {
      return NextResponse.json({ error: 'สถานะงานถูกเปลี่ยนระหว่างนี้ — รีเฟรชหน้าแล้วลองใหม่' }, { status: 409 })
    }
    const updated = { id: existing.id, status, bookingCode: existing.bookingCode }

    // No sheet Status write here (prod parity): PMDC's Airtable sync reads that
    // column and has never been confirmed to accept COMPLETED/ASSIGNED — pending
    // Nat's decision (maintenance 2026-11-08).
    // Forcing CONFIRMED stands in for approve, and approve (re)builds the crew's
    // OT drafts. Other targets leave OT alone, as before. Out of CANCELLED: no
    // side effects at all (see the warning below).
    if (status === 'CONFIRMED' && !fromCancelled) {
      syncBookingOT(existing.id).catch(e => console.error('[force-status] syncBookingOT error:', e?.message || e))
    }

    let warning: string | null = null
    if (fromCancelled) {
      // The reconciler's WHERE is CONFIRMED + NOT { PENDING, lastSynced >= 5 min
      // ago }: in SQL that is TRUE whenever calendarSyncStatus OR
      // calendarLastSyncedAt is set (any row that ever synced — cancel paths
      // don't clear lastSynced), and NULL (row skipped) only when BOTH are NULL.
      // A picked-up row with no event id = create + invite. Say which way this one goes.
      const calendar = status === 'CONFIRMED'
        ? (existing.calendarEventId
            ? 'event เดิมยังอยู่ในปฏิทิน (ลบตอนยกเลิกไม่สำเร็จ) — reconciler จะดูแลต่อในฐานะงาน CONFIRMED'
            : (existing.calendarSyncStatus || existing.calendarLastSyncedAt)
              ? 'force-status ไม่สร้าง event เอง แต่ reconciler จะสร้าง event ใหม่ + ส่ง invite ให้ทีมภายใน ~10 นาที เพราะใบเป็น CONFIRMED แล้ว (ใบนี้เคย sync ปฏิทิน)'
              : 'ไม่มี event ในปฏิทิน และ reconciler จะไม่สร้างให้ (ใบนี้ไม่เคย sync ปฏิทิน) — ถ้าต้องการ event ให้กด Re-sync calendar ในหน้าใบจอง')
        : (existing.calendarEventId
            ? 'event เดิมยังอยู่ในปฏิทิน (ลบตอนยกเลิกไม่สำเร็จ) และจะไม่มีใครลบต่อแล้วเพราะใบไม่ใช่ CANCELLED — ลบเองในปฏิทิน'
            : 'ไม่สร้าง/คืน event ในปฏิทิน')
      warning = `ใบนี้ถูกยกเลิกมาก่อน — force-status เปลี่ยนแค่สถานะ + ชีท + audit เท่านั้น · สิ่งที่ไม่ได้ทำ: ` +
        `(1) ปฏิทิน: ${calendar} (2) OT: ไม่สร้าง OT ของทีมคืน (ถูกล้างตอนยกเลิก) ` +
        `(3) ห้อง: ${status === 'COMPLETED' ? 'ไม่จองห้องคืน (คืนระบบกลางไปตอนยกเลิก)' : 'force-status ไม่จองห้องคืนเอง — รอบจองห้องรายชั่วโมงอาจจองให้ถ้ายังไม่ถึงวันถ่าย'} ` +
        `(4) คำขอยกเลิก (ถ้ามี) ยังค้างอยู่ · ` +
        `ถ้างานนี้จะถ่ายจริง ให้กู้คืน (Restore) แล้วอนุมัติใหม่แทน`
      console.warn(`[force-status] ${existing.bookingCode || existing.id}: CANCELLED → ${status} by ${session.email} — ${warning}`)
    }

    await logAudit({
      actorEmail: session.email,
      action: 'booking.force_status',
      entityType: 'Booking',
      entityId: existing.id,
      bookingCode: existing.bookingCode,
      fromStatus: existing.status,
      toStatus: status,
      changes: { forced: true, note, ...(warning ? { fromCancelled: true, warning } : {}) },
    })

    return NextResponse.json({ ok: true, booking: updated, ...(warning ? { warning } : {}) })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/force-status error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
