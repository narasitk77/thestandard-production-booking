import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
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
      select: { id: true, status: true, bookingCode: true, deletedAt: true },
    })
    if (!existing) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    if (existing.deletedAt) return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    if (existing.status === status) {
      return NextResponse.json({ ok: true, idempotent: true, booking: { id: existing.id, status } })
    }

    const updated = await prisma.booking.update({
      where: { id: params.id },
      data: { status },
      select: { id: true, status: true, bookingCode: true },
    })

    await logAudit({
      actorEmail: session.email,
      action: 'booking.force_status',
      entityType: 'Booking',
      entityId: existing.id,
      bookingCode: existing.bookingCode,
      fromStatus: existing.status,
      toStatus: status,
      changes: { forced: true, note },
    })

    return NextResponse.json({ ok: true, booking: updated })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/force-status error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
