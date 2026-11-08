import { NextRequest, NextResponse } from 'next/server'
import { releaseRoomForBooking } from '@/lib/room-booking-sync'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { removeCancelledBookingEvent } from '@/lib/calendar-reconcile'
import { updateBookingRow } from '@/lib/google-sheets'
import { clearBookingOT } from '@/lib/ot-sync'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/soft-delete — v1.51.0. ADMIN only.
 *
 * Hides a booking from every web surface (sets `deletedAt`) while keeping the
 * row — and its episodes, uploads, and audit history — in the database. Meant
 * for clearing test queues without burning the episode-ID sequence slots or
 * the audit trail the way the hard delete (admin/[id]/delete) does.
 *
 * Side effects mirror a cancel: the Google Calendar event is removed (the id
 * is cleared only on a confirmed delete; failures are retried by the reconcile
 * sweep) and auto-OT rows are cleared. Restore via POST /api/admin/[id]/undelete.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { id } = params
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, bookingCode: true, status: true, calendarEventId: true, deletedAt: true, sheetRowIndex: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (booking.deletedAt) return NextResponse.json({ error: 'Already deleted' }, { status: 409 })

  // v1.149 — mirror the cancel flows: the Sheet row must not keep showing a
  // live-looking Status + a now-dead Calendar Event ID (col W) for a hidden
  // booking — PMDC's Airtable sync merges Service Jobs by that event id, so a
  // ghost row misleads it. (The row itself stays — the booking still exists.)
  if (booking.sheetRowIndex) {
    // v1.150 — col-A lookup key must match what appendBookingRow wrote there:
    // bookingCode with the booking id as the legacy code-less fallback.
    updateBookingRow(booking.bookingCode || booking.id, { status: 'CANCELLED', calendarEventId: '' }).catch(e =>
      console.warn(`[soft-delete] sheet row update failed: ${e?.message || e}`)
    )
  }
  await clearBookingOT(id).catch(e =>
    console.warn(`[soft-delete] OT clear failed: ${e}`)
  )
  // v1.201 — ลบคิว = คืนห้องในระบบกลางด้วย เหตุผลเดียวกับตอนยกเลิก
  releaseRoomForBooking(id, 'booking-deleted')

  await prisma.booking.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      // calendarEventId is NOT nulled here: removeCancelledBookingEvent (below)
      // clears it only once Google confirms the delete. Blindly nulling it was
      // how a failed delete left the event on every crew calendar with nothing
      // pointing back to it. Sync status is still reset as before (undelete
      // does not recreate the event — Re-sync by hand).
      calendarSyncStatus: null,
      calendarSyncError: null,
    },
  })

  logAudit({
    actorEmail: session.email,
    action: 'booking.soft_delete',
    entityType: 'Booking',
    entityId: id,
    bookingCode: booking.bookingCode,
    fromStatus: booking.status,
  })
  // Google delete LAST and not awaited (googleapis has no timeout). Never throws;
  // a failure keeps the id + FAILED and the reconcile sweep retries + alerts ops.
  if (booking.calendarEventId) void removeCancelledBookingEvent(id, booking.calendarEventId)

  return NextResponse.json({ ok: true })
}
