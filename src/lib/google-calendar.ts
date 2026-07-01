import { google } from 'googleapis'
import { format } from 'date-fns'
import { logAudit } from './audit'
import { isEmailConfigured, sendEmail } from './email'
import { normalizeFreelancers, formatFreelancerLines, type Freelancer } from './freelancers'
import { bookingShowName } from './display'

// v1.41.0 — prefix added to the calendar event title when a booking needs a
// company van (off-site shoots). Surfaced on both the web calendar and Google
// Calendar so it's obvious at a glance.
const VAN_EMOJI = '🚐'

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ||
  '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com'

// v1.29.4 — hardcoded fallback for the impersonated Workspace user. Same
// value as the default baked into docker-compose.portainer.yml. Single-tenant
// internal tool, so safe to hardcode; this guards against the deploy class of
// bugs where Portainer's stale-compose cache drops the env var entirely
// (observed in prod on 2026-05-24 — the stack env editor showed the value
// but the running container had no GOOGLE_IMPERSONATE_SUBJECT). Override via
// the env var when running multi-tenant or in a different Workspace.
const DEFAULT_IMPERSONATE_SUBJECT = 'narasit.k@thestandard.co'
// Module-scope flag for the once-per-process warning when we fall back.
let _impersonateFallbackWarned = false

type CalendarAlertKind = 'invite_failed' | 'attendees_update_failed'

export function getCalendarImpersonateSubject(): string | undefined {
  const fromEnv = process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim()
  if (fromEnv) return fromEnv
  if (!_impersonateFallbackWarned) {
    console.warn(
      `[calendar] GOOGLE_IMPERSONATE_SUBJECT env not set — using built-in fallback "${DEFAULT_IMPERSONATE_SUBJECT}" so DWD still works. Set the env var to silence this warning or to point at a different Workspace user. See docs/runbook-impersonate-swap.md.`,
    )
    _impersonateFallbackWarned = true
    // v1.32.4 — also durably record the fallback usage in the audit
    // log so the audit-email alert path (v1.26.5) flags it. The
    // import is lazy to avoid a require-cycle with audit.ts which
    // doesn't depend on this module but may in the future.
    import('./audit').then(({ logAudit }) => {
      logAudit({
        actorEmail: 'calendar-impersonate-fallback',
        action: 'calendar.impersonate_fallback_in_use',
        entityType: 'System',
        changes: {
          fallbackSubject: DEFAULT_IMPERSONATE_SUBJECT,
          message: 'GOOGLE_IMPERSONATE_SUBJECT env not set — falling back to hardcoded default. See docs/runbook-impersonate-swap.md.',
        },
      })
    }).catch(() => {})
  }
  return DEFAULT_IMPERSONATE_SUBJECT
}

// Fire-and-forget alert when calendar guests fail to attach. Writes an AuditLog
// row (so the failure is durable and queryable) and emails an admin so they can
// react before guests find out by missing the invite. Recipient resolves to
// CALENDAR_ALERT_EMAIL, else GOOGLE_IMPERSONATE_SUBJECT (the impersonated user
// is the most likely owner to investigate DWD/permission drift). Never throws.
function notifyCalendarAlert(input: {
  kind: CalendarAlertKind
  bookingId?: string | null
  bookingCode?: string | null
  eventId?: string | null
  attendees: string[]
  error: unknown
  fallbackCreated?: boolean
}): void {
  const errMessage = (input.error as any)?.message || String(input.error)
  const impersonateSubject = getCalendarImpersonateSubject()
  const action = input.kind === 'invite_failed'
    ? 'calendar.invite_failed'
    : 'calendar.attendees_update_failed'

  void logAudit({
    action,
    entityType: 'Booking',
    entityId: input.bookingId ?? null,
    bookingCode: input.bookingCode ?? null,
    changes: {
      eventId: input.eventId ?? null,
      attendees: input.attendees,
      error: errMessage,
      impersonateSubject: impersonateSubject || null,
    },
  })

  const to = process.env.CALENDAR_ALERT_EMAIL?.trim() || impersonateSubject
  if (!to || !isEmailConfigured()) return

  const headline = input.kind === 'invite_failed'
    ? 'Calendar guest invite FAILED'
    : 'Calendar attendees UPDATE FAILED'
  const bookingLabel = input.bookingCode || input.bookingId || '(unknown booking)'
  const subject = `[Production Booking] ${headline} — ${bookingLabel}`
  const lines = [
    `${headline} for booking ${bookingLabel}.`,
    '',
    input.kind === 'invite_failed'
      ? input.fallbackCreated === false
        ? 'No fallback event was created. Assigned crew did not receive the invite.'
        : 'The event was created WITHOUT guests as a fallback. Assigned crew did not receive the invite.'
      : 'The patch to update attendees failed. The event keeps its previous guest list.',
    '',
    `Event ID:           ${input.eventId || '(none — fallback)'}`,
    `Affected guests:    ${input.attendees.join(', ') || '(none)'}`,
    `Impersonate user:   ${impersonateSubject || '(unset)'}`,
    '',
    'Error:',
    errMessage,
    '',
    'Likely causes:',
    '  - Domain-Wide Delegation revoked for the service account in Workspace',
    '  - Impersonate user lost access to the shared calendar',
    '  - Impersonate user account was disabled or removed',
    '',
    `Look up AuditLog (action="${action}") for full context.`,
  ]
  sendEmail({ to, subject, text: lines.join('\n') }).catch(e =>
    console.error('notifyCalendarAlert: sendEmail failed:', e?.message || e),
  )
}

/**
 * Canonical auth used by every Google Calendar call in this app.
 *
 * Exported so `/api/health` can exercise the exact same auth model
 * production uses, instead of approximating with a different scope /
 * impersonate combination (which caused v1.32.0 to report false
 * `unauthorized_client` failures even though calendar guest sync was
 * working — Codex review 2026-05-24).
 *
 * Scope: `https://www.googleapis.com/auth/calendar` (full read+write).
 * Impersonate: `GOOGLE_IMPERSONATE_SUBJECT` env (DWD) — required to
 * attach attendees to events; a bare service account cannot.
 */
export function getCalendarAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }

  // Optional Domain-Wide Delegation: impersonate a Workspace user so the service
  // account can INVITE ATTENDEES + send calendar invites (a bare service account
  // can't). Set GOOGLE_IMPERSONATE_SUBJECT to a @thestandard.co user who can
  // manage the shared calendar. Leave unset → no attendees (description only).
  const subject = getCalendarImpersonateSubject()

  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject,
  })
}
// Internal alias kept so the existing callsites (createCalendarEvent,
// updateCalendarEventAttendees, deleteCalendarEvent, getCalendarEventLink,
// getCalendarEventAttendees) don't need to change.
const getAuth = getCalendarAuth

function formatBangkokDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

function parseBangkokDateTime(date: Date, timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number)
  return `${formatBangkokDate(date)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`
}

function addHoursInBangkok(dateTime: string, hours: number): string {
  const next = new Date(new Date(dateTime).getTime() + hours * 60 * 60 * 1000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(next).map(part => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+07:00`
}

/**
 * Build the calendar event's description text. Shared by createCalendarEvent
 * and the assign route's attendee patch so the freelance contacts + admin
 * notes that admins add stay in sync on the event — not just in the email.
 *
 * `adminNotes` carries the admin-entered details AND the freelancer roster
 * (the admin detail page appends "Freelancers: name · contract · email" into
 * adminNotes before saving), so surfacing it here puts freelance contacts on
 * the calendar event itself.
 */
// Equipment line for the calendar — e.g. "🎥 2 · 🎙 1". Returns '' when neither
// count is set, so callers can omit the segment entirely.
function formatEquipment(cameraCount?: number | null, micCount?: number | null): string {
  const parts: string[] = []
  if (cameraCount && cameraCount > 0) parts.push(`🎥 ${cameraCount}`)
  if (micCount && micCount > 0) parts.push(`🎙 ${micCount}`)
  return parts.join(' · ')
}

/**
 * Canonical calendar event TITLE. Shared by createCalendarEvent and the
 * details-patch path (updateCalendarEventDetails) so a freshly-created event
 * and one updated after an edit always read the same — fixing the class of bug
 * where editing the shoot time / episode title left the old title on the event
 * (ops feedback, June 2026).
 *
 * Shape: `🚐 [OUT] Show — Episode · Video Type · 🎥 2 · 🎙 1`
 *   - "Show" resolves via the shared bookingShowName rule (display.ts):
 *     projectName (Content Agency, e.g. "KEY MESSAGES x DMHT") → the
 *     episodes' per-EP program name (outlet bookings, e.g. "Key Message")
 *     → the booking-level program name. Same rule as every in-app surface,
 *     so the event title agrees with the calendar/list pages.
 *   - The episode segment is dropped when it would just repeat the show name
 *     (CA episodes whose EP. label is "-" snapshot the project name as title).
 *   - 🚐 prefix only when the booking needs a van (off-site).
 *   - Video Type / equipment segments appear only when present.
 */
export function buildEventTitle(booking: {
  shootType: string
  videoType?: string | null
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
  projectName?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string; program?: { name: string } | null }>
}): string {
  const epCount = booking.episodes.length
  const showName = bookingShowName(booking)
  const firstEpTitle = booking.episodes[0]?.title?.trim()
  const core = epCount === 1
    ? (firstEpTitle && firstEpTitle !== showName
        ? `[${booking.outlet.code}] ${showName} — ${firstEpTitle}`
        : `[${booking.outlet.code}] ${showName}`)
    : `[${booking.outlet.code}] ${showName} — ${epCount} EPs`

  // Trailing descriptors so the event says what KIND of shoot it is at a glance
  // (ops feedback: the title didn't say what the item was). Video Type first
  // (the content descriptor), then the equipment counts.
  const segments: string[] = []
  if (booking.videoType && booking.videoType.trim()) segments.push(booking.videoType.trim())
  const equip = formatEquipment(booking.cameraCount, booking.micCount)
  if (equip) segments.push(equip)

  const titleBody = segments.length ? `${core} · ${segments.join(' · ')}` : core
  return booking.needsVan ? `${VAN_EMOJI} ${titleBody}` : titleBody
}

export function buildEventDescription(booking: {
  id: string
  bookingCode?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
  specialEquipment?: string[] | null
  freelancers?: unknown
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
  adminNotes?: string | null
}, assignedEmails: string[]): string {
  const location = booking.locationName || '—'
  const shootTypeLabel = booking.shootType.replace('_', ' ')
  const epList = booking.episodes.map(e => `• ${e.episodeId} — ${e.title}`).join('\n')
  const equip = formatEquipment(booking.cameraCount, booking.micCount)
  // Freelancers are rebuilt from the structured list every time (never appended)
  // so re-saving a booking can't duplicate names on the event.
  const freelancers: Freelancer[] = normalizeFreelancers(booking.freelancers)
  const base = `Production Booking
Episode IDs:
${epList}

Outlet: ${booking.outlet.name} (${booking.outlet.code})
Program: ${booking.program.name} (${booking.program.code})
Video Type: ${booking.videoType || '—'}
Shoot Type: ${shootTypeLabel}
Location / Room: ${location}
Producer: ${booking.producer}
Crew: ${booking.crewRequired.join(', ') || '—'}
Equipment: ${equip || '—'}
Special Equipment: ${booking.specialEquipment && booking.specialEquipment.length > 0 ? booking.specialEquipment.join(', ') : '—'}
Van required: ${booking.needsVan ? 'Yes 🚐' : 'No'}
Agency Ref: ${booking.agencyRef || '—'}
Notes: ${booking.notes || '—'}
Admin notes: ${booking.adminNotes || '—'}
Freelancers:
${freelancers.length ? formatFreelancerLines(freelancers) : '—'}

Production ID: ${booking.bookingCode || booking.id}
Auto-generated by THE STANDARD Production Booking`
  const assigned = (assignedEmails || []).filter(Boolean)
  return `${base}\n\nAssigned: ${assigned.join(', ') || '—'}`
}

export async function createCalendarEvent(booking: {
  id: string
  bookingCode?: string | null
  shootDate: Date | string
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
  specialEquipment?: string[] | null
  projectName?: string | null
  freelancers?: unknown
  assignedEmails?: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
  adminNotes?: string | null
}, options: {
  requireAttendees?: boolean
} = {}): Promise<string | null> {
  // v1.29.3 — every known failure path now throws with a human-readable
  // reason instead of silently returning null. Callers that previously
  // null-checked still handle null (defensive — possible only if Google
  // returns an event without an id), but the common cases (no creds, DWD
  // off, Google rejected attendees) bubble a real error message up to the
  // admin's Re-sync toast instead of "createCalendarEvent returned null".
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      'Google service account not configured — set GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY) in the Portainer stack env.',
    )
  }

  try {
    const auth = getAuth()
    const calendar = google.calendar({ version: 'v3', auth })

    const shootDate = new Date(booking.shootDate)
    const startTime = parseBangkokDateTime(shootDate, booking.callTime)
    const endTime = booking.estimatedWrap
      ? parseBangkokDateTime(shootDate, booking.estimatedWrap)
      : addHoursInBangkok(startTime, 4)

    // Location = the actual room/venue (independent of Shoot Type)
    const location = booking.locationName || '—'

    const title = buildEventTitle(booking)

    // Add the assigned crew as event GUESTS (attendees) — but only when
    // Domain-Wide Delegation is configured (GOOGLE_IMPERSONATE_SUBJECT set), as
    // a bare service account can't invite attendees. The "Assigned:" line stays
    // either way so crew still see the info on the shared calendar.
    const assignedEmails = (booking.assignedEmails || []).filter(Boolean)
    const fullDescription = buildEventDescription(booking, assignedEmails)
    const canInvite = Boolean(getCalendarImpersonateSubject())
    if (options.requireAttendees && assignedEmails.length > 0 && !canInvite) {
      const err = new Error(
        'GOOGLE_IMPERSONATE_SUBJECT not set (or env value is empty after trim) — Domain-Wide Delegation is required to add calendar guests. Set GOOGLE_IMPERSONATE_SUBJECT to a Workspace user (e.g. narasit.k@thestandard.co) in the Portainer stack env and redeploy.',
      )
      notifyCalendarAlert({
        kind: 'invite_failed',
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
        eventId: null,
        attendees: assignedEmails,
        error: err,
        fallbackCreated: false,
      })
      throw err
    }
    const attendees = canInvite ? assignedEmails.map(email => ({ email })) : []

    const baseBody = {
      summary: title,
      description: fullDescription,
      location,
      start: { dateTime: startTime, timeZone: 'Asia/Bangkok' },
      end: { dateTime: endTime, timeZone: 'Asia/Bangkok' },
      colorId: '11',
    }

    try {
      const event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        // 'all' → Google emails the guests an invite they can accept/decline.
        sendUpdates: attendees.length ? 'all' : 'none',
        requestBody: attendees.length ? { ...baseBody, attendees } : baseBody,
      })

      // v1.35.7 — verify attendees actually persisted. There's a class of
      // failure where the impersonated user has read-but-not-write access
      // to the shared calendar: Google returns 200 OK with the attendees
      // echoed in the response, then silently drops them when persisting.
      // Read-back to catch this and flag it as an alert. Adds ~150ms but
      // is the only reliable way to detect this without manual inspection.
      if (event.data.id && attendees.length > 0) {
        try {
          const readback = await calendar.events.get({
            calendarId: CALENDAR_ID,
            eventId: event.data.id,
          })
          const persisted = (readback.data.attendees || []).length
          if (persisted < attendees.length) {
            const msg = `Calendar attendees silently dropped — expected ${attendees.length}, persisted ${persisted}. Most likely cause: impersonated user "${getCalendarImpersonateSubject()}" has read-only access to the shared calendar. Open Calendar settings → share → grant "Make changes to events".`
            console.warn('[calendar] ' + msg)
            notifyCalendarAlert({
              kind: 'invite_failed',
              bookingId: booking.id,
              bookingCode: booking.bookingCode,
              eventId: event.data.id,
              attendees: assignedEmails,
              error: new Error(msg),
              fallbackCreated: true,
            })
          }
        } catch (verifyErr) {
          // Verify failed — non-fatal, event still exists. Just log.
          console.warn('[calendar] attendee readback verify failed:', (verifyErr as any)?.message || verifyErr)
        }
      }

      return event.data.id || null
    } catch (e: any) {
      // Attendees rejected (DWD not granted / impersonated user lacks access) —
      // fall back to creating the event WITHOUT guests so the booking still gets
      // its calendar entry.
      if (attendees.length) {
        console.warn(
          options.requireAttendees
            ? 'Calendar: could not add attendees (check Domain-Wide Delegation / GOOGLE_IMPERSONATE_SUBJECT) — strict create aborted:'
            : 'Calendar: could not add attendees (check Domain-Wide Delegation / GOOGLE_IMPERSONATE_SUBJECT) — creating event without guests:',
          e?.message || e,
        )
        if (options.requireAttendees) {
          notifyCalendarAlert({
            kind: 'invite_failed',
            bookingId: booking.id,
            bookingCode: booking.bookingCode,
            eventId: null,
            attendees: assignedEmails,
            error: e,
            fallbackCreated: false,
          })
          // Re-throw the upstream Google API error so the admin Re-sync
          // toast sees the actual failure reason (rate limit, calendar id
          // unknown, impersonated user lost access, etc.) instead of
          // "createCalendarEvent returned null".
          throw new Error(`Google Calendar rejected event create with attendees: ${e?.message || String(e)}`)
        }
        const event = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: baseBody })
        notifyCalendarAlert({
          kind: 'invite_failed',
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
          eventId: event.data.id || null,
          attendees: assignedEmails,
          error: e,
          fallbackCreated: true,
        })
        return event.data.id || null
      }
      throw e
    }
  } catch (e: any) {
    console.error('createCalendarEvent error:', e)
    // v1.29.3 — re-throw with context so callers can surface the real
    // reason to the user. All known specific failures (no creds, DWD off,
    // attendees rejected) are already pre-typed errors; this catches the
    // remaining unexpected ones (DNS, auth handshake, etc.) and wraps them
    // with a recognizable prefix.
    if (e instanceof Error) throw e
    throw new Error(`Calendar event create failed: ${String(e)}`)
  }
}

// Re-sync an existing event's guests after a re-assignment. Replaces the
// attendee list with the current assigned crew and notifies added/removed
// guests (sendUpdates: 'all'). No-op unless Domain-Wide Delegation is set
// (GOOGLE_IMPERSONATE_SUBJECT) — a bare service account can't manage attendees.
export async function updateCalendarEventAttendees(
  eventId: string,
  emails: string[],
  meta?: { bookingId?: string | null; bookingCode?: string | null; description?: string | null },
): Promise<boolean> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return false
  }
  if (!getCalendarImpersonateSubject()) {
    // Without DWD we can't touch attendees; the event keeps its original guests.
    return false
  }
  const wanted = emails.filter(Boolean)
  try {
    const calendar = google.calendar({ version: 'v3', auth: getAuth() })
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      sendUpdates: 'all',
      // patch replaces the attendees array — added crew get an invite, removed
      // crew get a cancellation. When the caller supplies a fresh description
      // (admin notes / freelance contacts changed on re-assign), patch it too
      // so the event details stay in sync with the email.
      requestBody: {
        attendees: wanted.map(email => ({ email })),
        ...(meta?.description ? { description: meta.description } : {}),
      },
    })

    // v1.35.7 — read back to confirm the patch actually stuck. Same
    // silent-drop class of failure as in createCalendarEvent. If the
    // persisted attendees count doesn't match, treat the patch as failed
    // and surface an alert so the admin UI shows the real reason.
    if (wanted.length > 0) {
      try {
        const readback = await calendar.events.get({ calendarId: CALENDAR_ID, eventId })
        const persisted = (readback.data.attendees || []).length
        if (persisted < wanted.length) {
          const msg = `Calendar attendee patch silently dropped — expected ${wanted.length}, persisted ${persisted}. Likely cause: impersonated user "${getCalendarImpersonateSubject()}" has read-only access to the shared calendar (grant "Make changes to events" in Calendar settings).`
          console.warn('[calendar] ' + msg)
          notifyCalendarAlert({
            kind: 'attendees_update_failed',
            bookingId: meta?.bookingId ?? null,
            bookingCode: meta?.bookingCode ?? null,
            eventId,
            attendees: wanted,
            error: new Error(msg),
          })
          return false
        }
      } catch (verifyErr) {
        console.warn('[calendar] attendee patch readback verify failed:', (verifyErr as any)?.message || verifyErr)
      }
    }

    return true
  } catch (e) {
    console.error('updateCalendarEventAttendees error:', e)
    notifyCalendarAlert({
      kind: 'attendees_update_failed',
      bookingId: meta?.bookingId ?? null,
      bookingCode: meta?.bookingCode ?? null,
      eventId,
      attendees: wanted,
      error: e,
    })
    return false
  }
}

// v1.41.0 — patch an existing event's CORE details (title, time, location,
// description) after an admin edits the booking. Separate from
// updateCalendarEventAttendees (which only touches the guest list): editing the
// shoot time or an episode title used to update the DB but leave the calendar
// event showing the old title/time (ops feedback, June 2026). Does NOT change
// attendees, so it's safe to call on edits that don't touch crew. Returns true
// on success, false on any failure (logged, never throws).
export async function updateCalendarEventDetails(
  eventId: string,
  booking: {
    id: string
    bookingCode?: string | null
    shootDate: Date | string
    callTime: string
    estimatedWrap?: string | null
    shootType: string
    videoType?: string | null
    locationName?: string | null
    producer: string
    cameraCount?: number | null
    micCount?: number | null
    needsVan?: boolean | null
    specialEquipment?: string[] | null
    projectName?: string | null
    freelancers?: unknown
    assignedEmails?: string[]
    outlet: { code: string; name: string }
    program: { code: string; name: string }
    episodes: Array<{ episodeId: string; title: string }>
    crewRequired: string[]
    agencyRef?: string | null
    notes?: string | null
    adminNotes?: string | null
  },
  // v1.109 — `sendUpdates` defaults to 'all' (an admin editing the shoot
  // time/title SHOULD notify crew). The ID-regeneration flow passes 'none': a
  // Production-ID/description rewrite isn't a schedule change, so it must not
  // spam every attendee — critical when a bulk migration patches many events.
  opts: { sendUpdates?: 'all' | 'none' } = {},
): Promise<boolean> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return false
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth: getAuth() })
    const shootDate = new Date(booking.shootDate)
    const startTime = parseBangkokDateTime(shootDate, booking.callTime)
    const endTime = booking.estimatedWrap
      ? parseBangkokDateTime(shootDate, booking.estimatedWrap)
      : addHoursInBangkok(startTime, 4)

    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      // No attendee change here, so notify guests only of the time/detail shift.
      sendUpdates: opts.sendUpdates ?? 'all',
      requestBody: {
        summary: buildEventTitle(booking),
        description: buildEventDescription(booking, (booking.assignedEmails || []).filter(Boolean)),
        location: booking.locationName || '—',
        start: { dateTime: startTime, timeZone: 'Asia/Bangkok' },
        end: { dateTime: endTime, timeZone: 'Asia/Bangkok' },
      },
    })
    return true
  } catch (e: any) {
    // v1.109 — a 404 means the event was deleted/aged out of the calendar. Treat
    // that as a no-op success (mirrors deleteCalendarEvent) rather than a failure,
    // so a stale calendarEventId can never permanently block an ID regenerate /
    // reprogram / migration (which aborts on a calendar failure).
    if (e?.code === 404 || e?.response?.status === 404) {
      console.warn('updateCalendarEventDetails: event not found (404) — treating as no-op:', eventId)
      return true
    }
    console.error('updateCalendarEventDetails error:', e?.message || e)
    return false
  }
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return false
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth: getAuth() })
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId,
      sendUpdates: 'none',
    })
    return true
  } catch (e: any) {
    if (e?.code === 404 || e?.response?.status === 404) return true
    console.error('deleteCalendarEvent error:', e?.message || e)
    return false
  }
}

export async function getCalendarEventAttendees(eventId: string): Promise<{
  exists: boolean
  attendees: string[]
  htmlLink?: string | null
}> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { exists: false, attendees: [] }
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth: getAuth() })
    const res = await calendar.events.get({ calendarId: CALENDAR_ID, eventId })
    return {
      exists: true,
      attendees: (res.data.attendees || [])
        .map(attendee => attendee.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
      htmlLink: res.data.htmlLink || null,
    }
  } catch (e: any) {
    if (e?.code === 404 || e?.response?.status === 404) {
      return { exists: false, attendees: [] }
    }
    throw e
  }
}

// Returns the public Google Calendar URL (htmlLink) for an event, so emails
// can link straight to the calendar event. Returns null if unavailable.
export async function getCalendarEventLink(eventId: string): Promise<string | null> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return null
  }
  try {
    const auth = getAuth()
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.get({ calendarId: CALENDAR_ID, eventId })
    return res.data.htmlLink || null
  } catch (e) {
    console.error('getCalendarEventLink error:', e)
    return null
  }
}
