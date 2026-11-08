import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { updateBookingRow } from '@/lib/google-sheets'
import { syncBookingOT } from '@/lib/ot-sync'
import { removeCancelledBookingEvent } from '@/lib/calendar-reconcile'
import { EPISODE_ORDER } from '@/lib/episode-order'

/**
 * Restore a CANCELLED booking back to live (status = REQUESTED).
 * - Calendar event was deleted on cancel (or is deleted here if that failed —
 *   409 if it still can't be); admin must re-Approve to recreate it.
 * - Sheet row gets updated.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!(await requireConsole())) {
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

    // The cancel-time delete may have failed (the id is kept until Google
    // confirms). Restoring with calendarEventId:null would orphan that live event
    // for good — the sweep only looks at CANCELLED rows — so remove it first and
    // refuse only when it still cannot be removed.
    if (existing.calendarEventId && !(await removeCancelledBookingEvent(existing.id, existing.calendarEventId))) {
      return NextResponse.json({ error: 'event ของรอบที่ยกเลิกยังลบจากปฏิทินไม่สำเร็จ — ลองกู้คืนใหม่อีกครั้ง', code: 'CALENDAR_DELETE_FAILED' }, { status: 409 })
    }

    const booking = await prisma.booking.update({
      where: { id: params.id },
      data: {
        status: 'REQUESTED',
        calendarEventId: null, // the cancelled run's event is confirmed gone (above)
        approvedAt: null,
        // v1.235 — ต้องล้างคู่กับ approvedAt เสมอ ไม่งั้นใบที่กลับไปเป็น REQUESTED
        // จะยังค้างชื่อคนอนุมัติของรอบก่อน (OT reject กับ purchases reject ทำถูกอยู่แล้ว
        // เส้นนี้หลุดเพราะตอนเขียนยังไม่มีคอลัมน์นี้)
        approvedByEmail: null,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
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
