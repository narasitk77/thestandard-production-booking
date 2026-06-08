import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireConsole } from '@/lib/session'
import {
  getCalendarAuth,
  getCalendarImpersonateSubject,
} from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ||
  '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com'

/**
 * GET /api/admin/calendar-debug
 *
 * Live-fire diagnostic for the Google Calendar guest-attach path. Creates
 * a throwaway event 24h from now with the impersonated user as the sole
 * attendee, reads it back, and deletes it — then returns a structured
 * report of WHICH step failed, with the raw Google API error.
 *
 * Used after a "calendar isn't sending invites" report so we know whether
 * the cause is:
 *   - GOOGLE_IMPERSONATE_SUBJECT env not set
 *   - DWD scope grant missing the 'calendar' scope
 *   - Impersonated user lost write access to the shared calendar
 *   - Calendar id wrong / deleted
 *   - Service account credentials missing / wrong
 *   - Google rate-limiting
 *
 * Read-only side effects: creates + deletes one test event. Doesn't
 * notify the impersonated user (sendUpdates='none') so the inbox stays
 * clean.
 *
 * Optional `?inviteSelf=1` flips sendUpdates to 'all' so the impersonate
 * subject actually receives the invite email — useful for "I'm not sure
 * if emails are being delivered" follow-up. Default off.
 */
export async function GET(request: NextRequest) {
  if (!(await requireConsole())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const { searchParams } = new URL(request.url)
  const inviteSelf = searchParams.get('inviteSelf') === '1'

  const report: any = {
    env: {
      hasServiceAccount: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON
        || (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)),
      impersonateSubjectEnv: process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim() || null,
      impersonateSubjectResolved: getCalendarImpersonateSubject() || null,
      calendarId: CALENDAR_ID,
    },
    steps: [] as Array<{ step: string; ok: boolean; ms: number; detail?: any; error?: string }>,
    summary: '',
    advice: [] as string[],
  }

  const log = (step: string, fn: () => Promise<{ detail?: any }>) =>
    (async () => {
      const t0 = Date.now()
      try {
        const out = await fn()
        report.steps.push({ step, ok: true, ms: Date.now() - t0, detail: out?.detail })
        return out
      } catch (e: any) {
        const ms = Date.now() - t0
        const raw = e?.response?.data || e?.errors || e?.message || String(e)
        report.steps.push({ step, ok: false, ms, error: typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 1000) })
        throw e
      }
    })()

  let createdEventId: string | null = null
  const impersonate = getCalendarImpersonateSubject()

  try {
    if (!report.env.hasServiceAccount) {
      report.summary = 'NO_SERVICE_ACCOUNT'
      report.advice.push('Set GOOGLE_SERVICE_ACCOUNT_JSON or (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY) in Portainer stack env.')
      return NextResponse.json(report, { status: 200 })
    }
    if (!impersonate) {
      report.summary = 'NO_IMPERSONATE_SUBJECT'
      report.advice.push('Set GOOGLE_IMPERSONATE_SUBJECT to a Workspace user (e.g. narasit.k@thestandard.co) with write access to the shared calendar AND Domain-Wide Delegation enabled in Workspace Admin.')
      return NextResponse.json(report, { status: 200 })
    }

    const calendar = google.calendar({ version: 'v3', auth: getCalendarAuth() })

    // STEP 1 — Authenticate (forces DWD JWT exchange via a calendar.get)
    await log('authenticate + read calendar metadata', async () => {
      const meta = await calendar.calendars.get({ calendarId: CALENDAR_ID })
      return { detail: { id: meta.data.id, summary: meta.data.summary, timeZone: meta.data.timeZone } }
    })

    // STEP 2 — Insert a throwaway event 24h from now, 30-min duration,
    // with the impersonate subject as the sole attendee.
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const end = new Date(start.getTime() + 30 * 60 * 1000)
    const sendUpdates = inviteSelf ? 'all' : 'none'

    const inserted = await log('insert event with 1 attendee (sendUpdates=' + sendUpdates + ')', async () => {
      const e = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        sendUpdates,
        requestBody: {
          summary: '[diag] calendar-debug — safe to delete',
          description: 'Throwaway event created by /api/admin/calendar-debug. Auto-deletes after the check.',
          start: { dateTime: start.toISOString() },
          end:   { dateTime: end.toISOString() },
          attendees: [{ email: impersonate }],
        },
      })
      createdEventId = e.data.id || null
      return { detail: {
        eventId: createdEventId,
        attendeesEcho: (e.data.attendees || []).map(a => ({ email: a.email, responseStatus: a.responseStatus })),
        htmlLink: e.data.htmlLink,
      } }
    })

    // STEP 3 — Read it back. Crucial check: does the attendees array
    // actually persist on Google's side? If insert silently dropped them,
    // we'd see an empty attendees array here.
    if (createdEventId) {
      await log('readback event.attendees', async () => {
        const e = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: createdEventId! })
        return { detail: {
          attendeeCount: (e.data.attendees || []).length,
          attendees: (e.data.attendees || []).map(a => ({ email: a.email, responseStatus: a.responseStatus })),
        } }
      })
    }
  } catch (e: any) {
    // step-level error is already captured; just continue to cleanup
  } finally {
    // STEP 4 — Cleanup (best-effort)
    if (createdEventId) {
      try {
        const calendar = google.calendar({ version: 'v3', auth: getCalendarAuth() })
        // v1.35.9 — if ?inviteSelf=1 sent an invite, also send the
        // cancellation so the impersonate subject's inbox stays clean.
        // Otherwise they'd see the invite + later notice the event is
        // gone with no explanation.
        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: createdEventId,
          sendUpdates: inviteSelf ? 'all' : 'none',
        })
        report.steps.push({ step: 'cleanup (delete test event)', ok: true, ms: 0 })
      } catch (e: any) {
        report.steps.push({ step: 'cleanup (delete test event)', ok: false, ms: 0, error: e?.message || String(e) })
        report.advice.push('Test event was created but cleanup failed — delete it manually from the calendar.')
      }
    }
  }

  // Summarize
  const allOk = report.steps.every((s: any) => s.ok)
  const lastFail = [...report.steps].reverse().find((s: any) => !s.ok)
  const readback = report.steps.find((s: any) => s.step.startsWith('readback'))
  if (allOk && readback?.detail?.attendeeCount > 0) {
    report.summary = 'OK — attendees attached + persisted'
    report.advice.push('If real bookings still show empty attendees, audit the assign route + check AuditLog for calendar.invite_failed entries.')
  } else if (allOk && readback?.detail?.attendeeCount === 0) {
    report.summary = 'ATTENDEES_SILENTLY_DROPPED — insert succeeded but Google did not persist the attendees'
    report.advice.push('Most common cause: the impersonated user (' + impersonate + ') has read-only access to the shared calendar. Open Calendar settings → share with specific people → grant "Make changes to events" to ' + impersonate + '.')
    report.advice.push('Less common: the calendar is owned by a non-domain account but DWD scope is restricted.')
  } else if (lastFail?.step?.includes('authenticate') || /unauthorized_client|invalid_grant/i.test(lastFail?.error || '')) {
    report.summary = 'DWD_NOT_GRANTED — service account is not allowed to impersonate ' + impersonate
    report.advice.push('Workspace Admin → Security → Access and data control → API controls → Manage Domain-Wide Delegation → add the service account client id with scope https://www.googleapis.com/auth/calendar')
    report.advice.push('Or confirm the impersonate subject email matches a real Workspace user (typo? account suspended?).')
  } else if (/forbidden|insufficient/i.test(lastFail?.error || '')) {
    report.summary = 'INSUFFICIENT_PERMISSIONS — DWD works but impersonated user lacks calendar access'
    report.advice.push('Open Google Calendar as ' + impersonate + ' and confirm they can see the shared "Production Bookings" calendar.')
    report.advice.push('If they can see but not edit: open the calendar settings → share → grant them "Make changes to events".')
  } else if (lastFail) {
    report.summary = 'FAILED at step: ' + lastFail.step
  } else {
    report.summary = 'UNKNOWN'
  }

  return NextResponse.json(report, { status: 200 })
}
