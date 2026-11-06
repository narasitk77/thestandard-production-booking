import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { updateBookingRow } from '@/lib/google-sheets'
import { syncBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'

/**
 * Restore a CANCELLED booking back to live (status = REQUESTED).
 * - Calendar event was deleted on cancel; admin must re-Approve to recreate it.
 * - Sheet row gets updated.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireConsole()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const existing = await prisma.booking.findUnique({ where: { id: params.id } })
    if (!existing) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    // v1.51 — soft-deleted bookings are frozen; undelete first
    if (existing.deletedAt) {
      return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    }
    if (existing.status !== 'CANCELLED') {
      return NextResponse.json({ error: 'Only CANCELLED bookings can be restored' }, { status: 400 })
    }

    const booking = await prisma.booking.update({
      where: { id: params.id },
      data: {
        status: 'REQUESTED',
        calendarEventId: null, // old event was deleted on cancel
        approvedAt: null,
        // v1.235 — ต้องล้างคู่กับ approvedAt เสมอ ไม่งั้นใบที่กลับไปเป็น REQUESTED
        // จะยังค้างชื่อคนอนุมัติของรอบก่อน (OT reject กับ purchases reject ทำถูกอยู่แล้ว
        // เส้นนี้หลุดเพราะตอนเขียนยังไม่มีคอลัมน์นี้)
        approvedByEmail: null,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
      },
    })

    // v1.281 — เส้นนี้ล้าง approvedAt/approvedByEmail ทิ้ง แต่ไม่เคยเขียน audit ⇒ ใบที่ถูกกู้
    // แล้วอนุมัติใหม่ "ลืม" ว่ารอบก่อนใครอนุมัติ และไม่รู้ว่าใครกดกู้ · เก็บค่าเดิมไว้ที่นี่ที่เดียว
    await logAudit({
      actorEmail: session.email,
      action: 'booking.restore',
      entityType: 'Booking',
      entityId: existing.id,
      bookingCode: existing.bookingCode,
      fromStatus: existing.status,
      toStatus: 'REQUESTED',
      changes: {
        approvedAt: { from: existing.approvedAt, to: null },
        approvedByEmail: { from: existing.approvedByEmail, to: null },
        calendarEventId: { from: existing.calendarEventId, to: null },
      },
    })

    if (existing.sheetRowIndex) {
      updateBookingRow(existing.bookingCode || '', {
        status: 'REQUESTED',
        calendarEventId: '',
        approvedAt: '',
      }).catch(() => {})
    }

    // Regenerate OT records (will create them again only if booking ends up
    // back at CONFIRMED or has crew + qualifying schedule)
    syncBookingOT(params.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({ booking })
  } catch (error) {
    console.error('POST /api/admin/[id]/restore error:', error)
    return NextResponse.json({ error: 'Failed to restore' }, { status: 500 })
  }
}
