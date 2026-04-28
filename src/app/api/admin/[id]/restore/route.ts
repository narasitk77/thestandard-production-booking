import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { updateBookingRow } from '@/lib/google-sheets'

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
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const existing = await prisma.booking.findUnique({ where: { id: params.id } })
    if (!existing) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
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
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    if (existing.sheetRowIndex) {
      updateBookingRow(existing.sheetRowIndex, {
        status: 'REQUESTED',
        calendarEventId: '',
        approvedAt: '',
      }).catch(() => {})
    }

    return NextResponse.json({ booking })
  } catch (error) {
    console.error('POST /api/admin/[id]/restore error:', error)
    return NextResponse.json({ error: 'Failed to restore' }, { status: 500 })
  }
}
