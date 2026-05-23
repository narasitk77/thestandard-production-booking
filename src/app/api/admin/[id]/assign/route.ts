import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendAssignmentEmail, buildEmailErrorHint } from '@/lib/email'
import { getValidGoogleAccessToken } from '@/lib/google-token'
import { updateBookingRow } from '@/lib/google-sheets'
import {
  createCalendarEvent,
  getCalendarEventLink,
  updateCalendarEventAttendees,
} from '@/lib/google-calendar'
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

    // ─── Calendar guest sync ────────────────────────────────────────────────
    // Goal (per ops feedback v1.28.2): when admin assigns crew, the Google
    // Calendar event must reflect the new guest list IMMEDIATELY, and the UI
    // must surface whether that succeeded.
    //
    // Three branches:
    //   (1) calendarEventId present → patch the existing event's attendees
    //       (sync; previously fire-and-forget, which silently lost failures).
    //   (2) calendarEventId NULL but booking is now CONFIRMED → auto-recover
    //       by creating the calendar event now with the assigned crew baked in.
    //       This covers the race window where approve's background create
    //       hadn't finished by the time admin clicked Assign, or where that
    //       create failed outright.
    //   (3) Booking still REQUESTED/ASSIGNED (no approve yet) → no-op; the
    //       approve route's createCalendarEvent will use the already-saved
    //       assignedEmails when admin eventually approves.
    //
    // Awaited so the response can carry { ok, eventId, error? } and the admin
    // UI can tell the user "✓ Saved & 3 guests added" vs. "⚠ guests NOT added
    // — DWD check needed".
    type CalendarSync =
      | { ok: true; eventId: string | null; action: 'patched' | 'created' | 'deferred'; note?: string }
      | { ok: false; eventId: string | null; action: 'patched' | 'created' | 'deferred'; error: string }
    let calendarSync: CalendarSync = { ok: true, eventId: booking.calendarEventId, action: 'deferred', note: 'Calendar event will be created when admin approves' }
    let resolvedCalendarEventId = booking.calendarEventId

    if (booking.calendarEventId) {
      // (1) Patch existing event's attendees.
      try {
        const ok = await updateCalendarEventAttendees(booking.calendarEventId, emailRecipients, {
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
        })
        if (ok) {
          calendarSync = { ok: true, eventId: booking.calendarEventId, action: 'patched' }
        } else {
          // Two reasons updateCalendarEventAttendees returns false without throwing:
          //   - GOOGLE_IMPERSONATE_SUBJECT not set (DWD off — can't manage attendees)
          //   - Google API rejected the patch (notifyCalendarAlert already wrote AuditLog)
          calendarSync = {
            ok: false,
            eventId: booking.calendarEventId,
            action: 'patched',
            error: process.env.GOOGLE_IMPERSONATE_SUBJECT
              ? 'Google Calendar API rejected the attendees update (see AuditLog calendar.attendees_update_failed)'
              : 'GOOGLE_IMPERSONATE_SUBJECT not set — cannot add calendar guests without Domain-Wide Delegation',
          }
        }
      } catch (e: any) {
        calendarSync = {
          ok: false,
          eventId: booking.calendarEventId,
          action: 'patched',
          error: e?.message || String(e),
        }
      }
    } else if (nextStatus === 'CONFIRMED') {
      // (2) Auto-recover: booking already CONFIRMED but has no event (race
      //     with approve's background create, or earlier create failure).
      try {
        const newEventId = await createCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          shootDate: booking.shootDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          locationName: booking.locationName,
          producer: booking.producer,
          // Bake the just-assigned crew into the new event so it has guests
          // from the moment it's created.
          assignedEmails: emailRecipients,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
        })
        if (newEventId) {
          await prisma.booking.update({
            where: { id: params.id },
            data: { calendarEventId: newEventId },
          }).catch(e => console.error('save recovered calendarEventId error:', e?.message || e))
          resolvedCalendarEventId = newEventId
          calendarSync = { ok: true, eventId: newEventId, action: 'created' }
        } else {
          calendarSync = {
            ok: false,
            eventId: null,
            action: 'created',
            error: 'createCalendarEvent returned null — check GOOGLE_SERVICE_ACCOUNT credentials',
          }
        }
      } catch (e: any) {
        calendarSync = { ok: false, eventId: null, action: 'created', error: e?.message || String(e) }
      }
    }

    // Email links straight to the event (whether existing, freshly patched, or
    // freshly auto-created). Skipped for the deferred branch — no event yet.
    const calendarUrl = resolvedCalendarEventId
      ? await getCalendarEventLink(resolvedCalendarEventId)
      : null

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
      booking: { ...booking, calendarEventId: resolvedCalendarEventId },
      email: {
        requested: emailRecipients.length,
        sent: sent.length,
        failed,
      },
      calendar: calendarSync,
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/assign error:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}
