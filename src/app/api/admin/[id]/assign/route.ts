import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { sendAssignmentEmail, buildEmailErrorHint } from '@/lib/email'
import { getValidGoogleAccessToken } from '@/lib/google-token'
import { updateBookingRow } from '@/lib/google-sheets'
import {
  buildEventDescription,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarImpersonateSubject,
  getCalendarEventLink,
  updateCalendarEventAttendees,
} from '@/lib/google-calendar'
import { requireConsole } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { normalizeFreelancers, freelancerEmails } from '@/lib/freelancers'
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
    const session = await requireConsole()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
    const senderAccessToken = await getValidGoogleAccessToken(authToken)
    const accessTokenError = (authToken as any)?.accessTokenError as string | undefined
    const { assignedEmails, adminNotes, mainVideographerEmail, freelancers, sendEmail } = await request.json()
    // v1.108.x — "Save" and "Send email" are separate actions now. The assignment
    // + calendar guest sync always persist; assignment emails go out only when the
    // admin explicitly asks (sendEmail !== false). "Save" passes sendEmail:false.
    const shouldSendEmail = sendEmail !== false
    // v1.41.0 — freelancers arrive as a structured list (not appended text), so
    // re-saving can't duplicate names. Their emails join the staff emails as
    // calendar guests / mail recipients; names without an email still ride along
    // on the event description.
    const staffEmails = cleanEmailList(assignedEmails)
    const freelancerList = normalizeFreelancers(freelancers)
    const emailRecipients = Array.from(new Set([...staffEmails, ...freelancerEmails(freelancerList)]))
    // Only persist a main videographer if they're actually in the assigned list.
    const mainVdo = typeof mainVideographerEmail === 'string' && mainVideographerEmail.trim() && emailRecipients.includes(mainVideographerEmail.trim())
      ? mainVideographerEmail.trim()
      : null

    const existing = await prisma.booking.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // v1.51 — assigning a soft-deleted booking would re-create the calendar
    // event + OT rows the delete just removed; restore it first.
    if (existing.deletedAt) {
      return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    }

    // Status logic: don't downgrade a booking that's already progressed. Re-assigning
    // crew on a CONFIRMED *or COMPLETED* booking (e.g. a shoot-day crew swap) must keep
    // its status — only REQUESTED/ASSIGNED settle to ASSIGNED. (Bugfix: COMPLETED used to
    // fall through to ASSIGNED, bouncing a finished shoot back a step.)
    const nextStatus = (existing.status === 'CONFIRMED' || existing.status === 'COMPLETED')
      ? existing.status
      : 'ASSIGNED'

    const booking = await prisma.booking.update({
      where: { id: params.id },
      data: {
        assignedEmails: emailRecipients,
        mainVideographerEmail: mainVdo,
        adminNotes: adminNotes || null,
        freelancers: freelancerList as unknown as Prisma.InputJsonValue,
        status: nextStatus,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
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
          // Refresh the event details too — admin notes / freelance contacts
          // may have changed on this re-assign, so keep the event in sync with
          // the email (not just the guest list).
          description: buildEventDescription(booking, emailRecipients),
        })
        if (ok) {
          calendarSync = { ok: true, eventId: booking.calendarEventId, action: 'patched' }
          // v1.32.2 — record sync state on successful patch.
          await prisma.booking.update({
            where: { id: params.id },
            data: {
              calendarSyncStatus: 'OK',
              calendarSyncError: null,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(() => {})
        } else {
          // Two reasons updateCalendarEventAttendees returns false without throwing:
          //   - GOOGLE_IMPERSONATE_SUBJECT not set (DWD off — can't manage attendees)
          //   - Google API rejected the patch (notifyCalendarAlert already wrote AuditLog)
          calendarSync = {
            ok: false,
            eventId: booking.calendarEventId,
            action: 'patched',
            error: getCalendarImpersonateSubject()
              ? 'Google Calendar API rejected the attendees update (see AuditLog calendar.attendees_update_failed)'
              : 'GOOGLE_IMPERSONATE_SUBJECT not set — cannot add calendar guests without Domain-Wide Delegation',
          }
          await prisma.booking.update({
            where: { id: params.id },
            data: {
              calendarSyncStatus: 'FAILED',
              calendarSyncError: calendarSync.error,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(() => {})
        }
      } catch (e: any) {
        calendarSync = {
          ok: false,
          eventId: booking.calendarEventId,
          action: 'patched',
          error: e?.message || String(e),
        }
        await prisma.booking.update({
          where: { id: params.id },
          data: {
            calendarSyncStatus: 'FAILED',
            calendarSyncError: (e?.message || String(e)).slice(0, 500),
            calendarLastSyncedAt: new Date(),
          },
        }).catch(() => {})
      }
    } else if (nextStatus === 'CONFIRMED') {
      // (2) Auto-recover: booking already CONFIRMED but has no event (race
      //     with approve's background create, or earlier create failure).
      try {
        const newEventId = await createCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          shootDate: booking.shootDate,
          shootEndDate: booking.shootEndDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          videoType: booking.videoType,
          locationName: booking.locationName,
          producer: booking.producer,
          cameraCount: booking.cameraCount,
          micCount: booking.micCount,
          needsVan: booking.needsVan,
          isBlockShot: booking.isBlockShot,
          specialEquipment: booking.specialEquipment,
          projectName: booking.projectName,
          freelancers: booking.freelancers,
          // Bake the just-assigned crew into the new event so it has guests
          // from the moment it's created.
          assignedEmails: emailRecipients,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
          // Carry admin notes + freelance contacts onto the new event.
          adminNotes: booking.adminNotes,
        }, {
          requireAttendees: emailRecipients.length > 0,
        })
        if (newEventId) {
          // v1.111 — compare-and-swap: only claim the slot if calendarEventId is
          // STILL null. Approve's background create / the reconciler may have won
          // meanwhile; blindly writing here overwrote their id and left their
          // event as a calendar duplicate (ops report 2026-07-02). On lose,
          // delete the event we just made and use the winner's.
          const saved = await prisma.booking.updateMany({
            where: { id: params.id, calendarEventId: null },
            data: {
              calendarEventId: newEventId,
              // v1.32.2 — record sync state on auto-recover create.
              calendarSyncStatus: 'OK',
              calendarSyncError: null,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(e => { console.error('save recovered calendarEventId error:', e?.message || e); return null })
          if (saved && saved.count === 0) {
            console.warn(`[assign] booking ${params.id} already got an event mid-create — deleting duplicate event ${newEventId}`)
            deleteCalendarEvent(newEventId).catch(() => {})
            const winner = await prisma.booking.findUnique({ where: { id: params.id }, select: { calendarEventId: true } }).catch(() => null)
            resolvedCalendarEventId = winner?.calendarEventId ?? null
            calendarSync = { ok: true, eventId: resolvedCalendarEventId, action: 'created' }
          } else {
            resolvedCalendarEventId = newEventId
            calendarSync = { ok: true, eventId: newEventId, action: 'created' }
          }
        } else {
          calendarSync = {
            ok: false,
            eventId: null,
            action: 'created',
            error: 'createCalendarEvent returned null — check GOOGLE_SERVICE_ACCOUNT credentials',
          }
          // v1.32.2 — also flag on the booking so the admin list shows FAILED.
          await prisma.booking.update({
            where: { id: params.id },
            data: {
              calendarSyncStatus: 'FAILED',
              calendarSyncError: calendarSync.error,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(() => {})
        }
      } catch (e: any) {
        calendarSync = { ok: false, eventId: null, action: 'created', error: e?.message || String(e) }
        await prisma.booking.update({
          where: { id: params.id },
          data: {
            calendarSyncStatus: 'FAILED',
            calendarSyncError: (e?.message || String(e)).slice(0, 500),
            calendarLastSyncedAt: new Date(),
          },
        }).catch(() => {})
      }
    }

    // Email links straight to the event (whether existing, freshly patched, or
    // freshly auto-created). Skipped for the deferred branch — no event yet.
    const calendarUrl = resolvedCalendarEventId
      ? await getCalendarEventLink(resolvedCalendarEventId)
      : null

    // Send emails synchronously so the UI can show real per-recipient results.
    // Skipped entirely when the admin clicked "Save" (sendEmail:false) — save-only.
    const sendResults = !shouldSendEmail ? [] : await Promise.all(
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
      updateBookingRow(booking.bookingCode || '', {
        assignedEmails: emailRecipients.join(', '),
        status: nextStatus,
        mainVideographer: mainVdo || '',
      }).catch(e => console.error('updateBookingRow error:', e?.message || e))
    }

    syncBookingOT(booking.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({
      booking: { ...booking, calendarEventId: resolvedCalendarEventId },
      email: {
        requested: emailRecipients.length,
        sent: sent.length,
        failed,
        skipped: !shouldSendEmail,
      },
      calendar: calendarSync,
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/assign error:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}
