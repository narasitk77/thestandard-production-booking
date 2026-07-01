import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { updateBookingRow } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/resync-sheet
 *
 * Rewrite a booking's Producer Dashboard row (Shoot Date / Shoot End Date / Status)
 * from the DB — for repairing a row that drifted (e.g. a date fixed in the DB but
 * still stale in the sheet). AGN-only rows exist in the sheet; a non-AGN call
 * no-ops ('not-found'). Admin-only.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: { bookingCode: true, shootDate: true, shootEndDate: true, status: true },
    })
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    if (!booking.bookingCode) return NextResponse.json({ error: 'Booking has no code' }, { status: 400 })

    const fmt = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')
    const result = await updateBookingRow(booking.bookingCode, {
      shootDate: fmt(booking.shootDate),
      shootEndDate: fmt(booking.shootEndDate),
      status: booking.status,
    })

    return NextResponse.json({ ok: result === 'updated', result, bookingCode: booking.bookingCode, shootDate: fmt(booking.shootDate) })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/resync-sheet error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
