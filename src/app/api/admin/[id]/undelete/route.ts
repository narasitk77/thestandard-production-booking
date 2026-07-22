import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { updateBookingRow } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/undelete — v1.51.0. ADMIN only.
 *
 * Brings a soft-deleted booking back onto the web surfaces (clears
 * `deletedAt`). The Google Calendar event is NOT recreated automatically —
 * for a CONFIRMED booking, use the Re-sync button (calendar-resync) after
 * restoring.
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
    select: { id: true, bookingCode: true, status: true, deletedAt: true, sheetRowIndex: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!booking.deletedAt) return NextResponse.json({ error: 'Not deleted' }, { status: 409 })

  await prisma.booking.update({ where: { id }, data: { deletedAt: null } })

  // v1.150 — inverse of soft-delete's Sheet write: that flow stamps Status=
  // CANCELLED + blanks col W, so without this an undeleted CONFIRMED booking
  // stays CANCELLED forever on the Bookings tab PMDC's Airtable reads. Col W
  // stays blank on purpose — the calendar event is NOT recreated here (the
  // Re-sync flow writes the new event id back when it runs).
  if (booking.sheetRowIndex) {
    updateBookingRow(booking.bookingCode || booking.id, { status: booking.status }).catch(e =>
      console.warn(`[undelete] sheet row update failed: ${e?.message || e}`)
    )
  }

  logAudit({
    actorEmail: session.email,
    action: 'booking.undelete',
    entityType: 'Booking',
    entityId: id,
    bookingCode: booking.bookingCode,
    toStatus: booking.status,
  })

  return NextResponse.json({ ok: true })
}
