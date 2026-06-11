import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'

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
    select: { id: true, bookingCode: true, status: true, deletedAt: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!booking.deletedAt) return NextResponse.json({ error: 'Not deleted' }, { status: 409 })

  await prisma.booking.update({ where: { id }, data: { deletedAt: null } })

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
