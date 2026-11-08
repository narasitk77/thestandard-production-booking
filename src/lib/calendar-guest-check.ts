/**
 * The "Calendar guests" check on the admin booking page — maint 2026-11-08 (ui-11).
 *
 * WHY. The card diffed the event's attendees against `assignedEmails` (crew
 * only), while the reconciler deliberately invites crew + Producer + Co-Producer
 * (+ Directors on AGN) via bookingCalendarAttendees. So every booking with a
 * producer showed an amber "extra guest", routine bookings (no crew) could never
 * go green, and a producer actually MISSING from the event was never flagged —
 * a check that is always amber teaches people to ignore it (bug-classes §6, §9).
 * Expected guests now come from the same function the reconciler sends with.
 */
import { bookingCalendarAttendees, type CalendarAttendeeInput } from './calendar-attendees'

export interface GuestCheck {
  expected: string[]
  onEvent: string[]
  missing: string[]
  extra: string[]
  inSync: boolean
}

export function calendarGuestCheck(booking: CalendarAttendeeInput, eventAttendees: string[] | null | undefined): GuestCheck {
  const norm = (xs: string[]) => Array.from(new Set(xs.map(e => e.trim().toLowerCase()).filter(Boolean)))
  const expected = norm(bookingCalendarAttendees(booking))
  const onEvent = norm(eventAttendees || [])
  const missing = expected.filter(e => !onEvent.includes(e))
  const extra = onEvent.filter(e => !expected.includes(e))
  return { expected, onEvent, missing, extra, inSync: expected.length > 0 && missing.length === 0 && extra.length === 0 }
}
