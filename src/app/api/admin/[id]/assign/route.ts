import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendAssignmentEmail, buildEmailErrorHint } from '@/lib/email'
import { getValidGoogleAccessToken } from '@/lib/google-token'
import { updateBookingRow } from '@/lib/google-sheets'
import { getCalendarEventLink, updateCalendarEventAttendees } from '@/lib/google-calendar'
import { requireAdmin } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { format } from 'date-fns'
import { getToken } from 'next-auth/jwt'

function cleanEmailList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((email): email is string => typeof email === 'string')
      .map(email => email.trim())
      .filter(Boolean)
  ))
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdmin()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
    const senderAccessToken = await getValidGoogleAccessToken(authToken)
    const accessTokenError = (authToken as any)?.accessTokenError as string | undefined
    const { assignedEmails, adminNotes, mainVideographerEmail } = await request.json()
    const emailRecipients = cleanEmailList(assignedEmails)
    // Only persist a main videographer if they're actually in the assigned list.
    const mainVdo = typeof mainVideographerEmail === 'string' && mainVideographerEmail.trim() && emailRecipients.includes(mainVideographerEmail.trim())
      ? mainVideographerEmail.trim()
      : null

    const existing = await prisma.booking.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Status logic: don't downgrade CONFIRMED bookings during re-assign.
    const nextStatus = existing.status === 'CONFIRMED' ? 'CONFIRMED' : 'ASSIGNED'

    const booking = await prisma.booking.update({
      where: { id: params.id },
      data: {
        assignedEmails: emailRecipients,
        mainVideographerEmail: mainVdo,
        adminNotes: adminNotes || null,
        status: nextStatus,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // If the booking already has a Google Calendar event, the assignment email
    // links straight to it (created when the booking was approved).
    const calendarUrl = booking.calendarEventId
      ? await getCalendarEventLink(booking.calendarEventId)
      : null

    // Re-assign: keep the calendar event's GUESTS in sync with the new crew
    // (added crew get an invite, removed crew a cancellation). Fire-and-forget;
    // no-op without Domain-Wide Delegation.
    if (booking.calendarEventId) {
      updateCalendarEventAttendees(booking.calendarEventId, emailRecipients, {
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
      }).catch(e =>
        console.error('updateCalendarEventAttendees error:', e?.message || e),
      )
    }

    // Send emails synchronously so the UI can show real per-recipient results.
    const sendResults = await Promise.all(
      emailRecipients.map(async (email) => {
        try {
          await sendAssignmentEmail({
            to: email,
            toName: email.split('@')[0],
            bookingId: booking.id,
            outletName: booking.outlet.name,
            programName: booking.program.name,
            shootDate: format(new Date(booking.shootDate), 'yyyy-MM-dd'),
            shootEndDate: booking.shootEndDate ? format(new Date(booking.shootEndDate), 'yyyy-MM-dd') : null,
            callTime: booking.callTime,
            estimatedWrap: booking.estimatedWrap,
            shootType: booking.shootType,
            locationName: booking.locationName,
            producer: booking.producer,
            episodes: booking.episodes,
            notes: booking.notes,
            adminNotes: booking.adminNotes,
            senderAccessToken,
            senderEmail: session.email,
            calendarUrl,
          })
          return { email, ok: true as const }
        } catch (err: any) {
          const detail = err?.message || String(err)
          console.error(`Email to ${email} failed:`, detail)
          return {
            email,
            ok: false as const,
            error: detail,
            hint: buildEmailErrorHint(err, accessTokenError),
          }
        }
      })
    )

    const sent = sendResults.filter(r => r.ok)
    const failed = sendResults
      .filter((r): r is { email: string; ok: false; error: string; hint?: string } => !r.ok)
      .map(r => ({ email: r.email, error: r.error, hint: r.hint }))

    if (booking.sheetRowIndex) {
      updateBookingRow(booking.sheetRowIndex, {
        assignedEmails: emailRecipients.join(', '),
        status: nextStatus,
      }).catch(e => console.error('updateBookingRow error:', e?.message || e))
    }

    syncBookingOT(booking.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({
      booking,
      email: {
        requested: emailRecipients.length,
        sent: sent.length,
        failed,
      },
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/assign error:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}
