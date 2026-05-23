import { google } from 'googleapis'
import { format } from 'date-fns'
import { logAudit } from './audit'
import { isEmailConfigured, sendEmail } from './email'

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ||
  '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com'

type CalendarAlertKind = 'invite_failed' | 'attendees_update_failed'

export function getCalendarImpersonateSubject(): string | undefined {
  return process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim() || undefined
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

function getAuth() {
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

export async function createCalendarEvent(booking: {
  id: string
  bookingCode?: string | null
  shootDate: Date | string
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  locationName?: string | null
  producer: string
  assignedEmails?: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
}, options: {
  requireAttendees?: boolean
} = {}): Promise<string | null> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.warn('Google Calendar: no credentials configured')
    return null
  }

  try {
    const auth = getAuth()
    const calendar = google.calendar({ version: 'v3', auth })

    const shootDate = new Date(booking.shootDate)
    const startTime = parseBangkokDateTime(shootDate, booking.callTime)
    const endTime = booking.estimatedWrap
      ? parseBangkokDateTime(shootDate, booking.estimatedWrap)
      : addHoursInBangkok(startTime, 4)

    const epCount = booking.episodes.length
    // Location = the actual room/venue (independent of Shoot Type)
    const location = booking.locationName || '—'
    const shootTypeLabel = booking.shootType.replace('_', ' ')

    const title = epCount === 1
      ? `[${booking.outlet.code}] ${booking.program.name} — ${booking.episodes[0].title}`
      : `[${booking.outlet.code}] ${booking.program.name} — ${epCount} EPs`

    const epList = booking.episodes.map(e => `• ${e.episodeId} — ${e.title}`).join('\n')
    const description = `Production Booking
Episode IDs:
${epList}

Outlet: ${booking.outlet.name} (${booking.outlet.code})
Program: ${booking.program.name} (${booking.program.code})
Shoot Type: ${shootTypeLabel}
Location / Room: ${location}
Producer: ${booking.producer}
Crew: ${booking.crewRequired.join(', ') || '—'}
Agency Ref: ${booking.agencyRef || '—'}
Notes: ${booking.notes || '—'}

Booking ID: ${booking.id}
Auto-generated by THE STANDARD Production Booking`

    // Add the assigned crew as event GUESTS (attendees) — but only when
    // Domain-Wide Delegation is configured (GOOGLE_IMPERSONATE_SUBJECT set), as
    // a bare service account can't invite attendees. The "Assigned:" line stays
    // either way so crew still see the info on the shared calendar.
    const assignedEmails = (booking.assignedEmails || []).filter(Boolean)
    const fullDescription = `${description}\n\nAssigned: ${assignedEmails.join(', ') || '—'}`
    const canInvite = Boolean(getCalendarImpersonateSubject())
    if (options.requireAttendees && assignedEmails.length > 0 && !canInvite) {
      notifyCalendarAlert({
        kind: 'invite_failed',
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
        eventId: null,
        attendees: assignedEmails,
        error: new Error('GOOGLE_IMPERSONATE_SUBJECT not set — strict create aborted before creating a no-guest event'),
        fallbackCreated: false,
      })
      return null
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
          return null
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
  } catch (e) {
    console.error('createCalendarEvent error:', e)
    return null
  }
}

// Re-sync an existing event's guests after a re-assignment. Replaces the
// attendee list with the current assigned crew and notifies added/removed
// guests (sendUpdates: 'all'). No-op unless Domain-Wide Delegation is set
// (GOOGLE_IMPERSONATE_SUBJECT) — a bare service account can't manage attendees.
export async function updateCalendarEventAttendees(
  eventId: string,
  emails: string[],
  meta?: { bookingId?: string | null; bookingCode?: string | null },
): Promise<boolean> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return false
  }
  if (!getCalendarImpersonateSubject()) {
    // Without DWD we can't touch attendees; the event keeps its original guests.
    return false
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth: getAuth() })
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      sendUpdates: 'all',
      // patch replaces the attendees array — added crew get an invite, removed
      // crew get a cancellation.
      requestBody: { attendees: emails.filter(Boolean).map(email => ({ email })) },
    })
    return true
  } catch (e) {
    console.error('updateCalendarEventAttendees error:', e)
    notifyCalendarAlert({
      kind: 'attendees_update_failed',
      bookingId: meta?.bookingId ?? null,
      bookingCode: meta?.bookingCode ?? null,
      eventId,
      attendees: emails.filter(Boolean),
      error: e,
    })
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
