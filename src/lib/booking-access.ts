// Booking read-scope (v1.50.1).
//
// GET /api/bookings/[id] returns the full booking detail — including upload
// rows, adminNotes, and the assigned crew list — so reading it must be scoped
// the same way the list endpoint scopes `scope=mine`:
//
//   - the requester (createdByEmail)
//   - assigned crew (assignedEmails)
//   - the producer of the shoot (producerEmail)
//   - any console tier (ADMIN / SUPPORT / MANAGER / COORDINATOR)
//   - anyone, once the shoot is CONFIRMED (v1.131)
//
// The CONFIRMED-for-everyone branch matches the list endpoint
// (GET /api/bookings with no scope already returns every CONFIRMED booking to
// any signed-in user, for capacity-planning visibility — see the "First Come
// First Served" notice on the Overview page). Before v1.131 the list exposed
// a CONFIRMED booking's summary to everyone but the detail route 403'd on
// click-through, so a plain user landed on a page reading "Forbidden".
//
// Email comparisons are case-insensitive: session emails are lowercased by
// getSession(), but assignedEmails / producerEmail / createdByEmail are stored
// as entered and may carry mixed case from the Sheets-era data.

import { hasConsoleAccess } from './roles'

export interface BookingAccessFields {
  createdByEmail: string | null
  producerEmail: string | null
  assignedEmails: string[]
  status?: string | null
}

export function canViewBooking(
  viewer: { email: string; role?: string | null },
  _booking: BookingAccessFields,
): boolean {
  // v1.152 — transparent schedule: any signed-in user may open any live
  // booking's detail, matching the list/calendar which now show every booking
  // regardless of status. Keeping the detail route stricter than the list is
  // what produced the v1.131 bug (a booking visible on the calendar answered
  // "Forbidden" on click-through), and this time REQUESTED shoots are on the
  // calendar too, so the mismatch would hit far more people.
  //
  // What this does NOT open up: soft-deleted bookings (the route 404s those for
  // non-ADMIN before reaching here), and every mutation — approve/assign/edit/
  // cancel — which keeps its own owner/console check. adminNotes travels in the
  // detail payload; ops accepted that as part of "transparent data" (the notes
  // are operational, not personal). If that ever needs walling off again,
  // redact the field for non-console viewers rather than 403-ing the page.
  if (hasConsoleAccess(viewer.role)) return true
  return !!(viewer.email || '').trim()
}
