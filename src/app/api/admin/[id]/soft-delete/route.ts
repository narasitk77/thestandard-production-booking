import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { deleteCalendarEvent } from '@/lib/google-calendar'
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
 * Side effects mirror a cancel: the Google Calendar event is removed
 * best-effort (a hidden booking must not keep a live event) and auto-OT rows
 * are cleared. Restore via POST /api/admin/[id]/undelete.
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
    select: { id: true, bookingCode: true, status: true, calendarEventId: true, deletedAt: true },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (booking.deletedAt) return NextResponse.json({ error: 'Already deleted' }, { status: 409 })

  if (booking.calendarEventId) {
    deleteCalendarEvent(booking.calendarEventId).catch(e =>
      console.warn(`[soft-delete] calendar event delete failed: ${e}`)
    )
  }
  await clearBookingOT(id).catch(e =>
    console.warn(`[soft-delete] OT clear failed: ${e}`)
  )

  await prisma.booking.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      // The event is gone (or going) — drop the pointer so a later restore +
      // calendar-resync creates a fresh one instead of patching a dead id.
      calendarEventId: null,
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

  return NextResponse.json({ ok: true })
}
