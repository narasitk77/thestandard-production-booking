/**
 * GET /api/bookings/:id/history
 *
 * Returns the audit trail for one booking, newest first. Anyone who can see
 * the booking detail page can see its history (no extra admin gate) — the
 * sensitive bits (admin notes) are already filtered out at the booking GET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        bookingCode: true,
        deletedAt: true,
        createdByEmail: true,
        producerEmail: true,
        assignedEmails: true,
        status: true,
      },
    })
    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    // v1.51 — soft-deleted bookings are invisible except to ADMIN; same rule
    // as the detail GET, so history can't confirm a hidden booking exists.
    if (booking.deletedAt && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    // Same read-scope as the detail GET (src/lib/booking-access.ts) — history
    // exposes the same adminNotes/status data the detail page already shows,
    // so it must be gated the same way.
    if (!canViewBooking(session, booking)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        entityType: 'Booking',
        OR: [
          { entityId: booking.id },
          ...(booking.bookingCode ? [{ bookingCode: booking.bookingCode }] : []),
        ],
      },
      orderBy: { at: 'desc' },
      take: 200,
    })

    return NextResponse.json({ history: logs })
  } catch (error) {
    console.error('GET /api/bookings/[id]/history error:', error)
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 })
  }
}
