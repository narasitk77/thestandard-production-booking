import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { deleteCalendarEvent } from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/delete
 * Hard-deletes a booking and all related records. ADMIN only.
 * Episodes + uploads cascade automatically (onDelete: Cascade).
 * Audit logs, footage_log, and auto-generated ot_records rows referencing
 * this booking are cleaned up explicitly (no FK cascade on those tables).
 * The Google Calendar event is deleted best-effort.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = params

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, bookingCode: true, status: true, calendarEventId: true, outlet: { select: { name: true } }, program: { select: { name: true } } },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Best-effort: delete calendar event if it exists
  if (booking.calendarEventId) {
    deleteCalendarEvent(booking.calendarEventId).catch(e =>
      console.warn(`[delete-booking] calendar event delete failed: ${e}`)
    )
  }

  // Clean up audit_logs, footage_log, and auto-OT rows that reference this
  // booking (no FK cascade on those tables). Manual OT entries have
  // bookingId = null and are untouched.
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { entityId: id } }),
    prisma.footageLog.deleteMany({ where: { bookingId: id } }),
    prisma.oTRecord.deleteMany({ where: { bookingId: id } }),
    prisma.booking.delete({ where: { id } }), // cascades episodes + uploads
  ])

  // Write a post-delete audit entry so we have a trail
  await logAudit({
    actorEmail: session.email,
    action: 'admin.delete_booking',
    entityType: 'booking',
    entityId: id,
    changes: {
      bookingCode: booking.bookingCode,
      status: booking.status,
      outlet: booking.outlet?.name,
      program: booking.program?.name,
    },
  })

  return NextResponse.json({ ok: true })
}
