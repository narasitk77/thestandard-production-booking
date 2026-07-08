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
  booking: BookingAccessFields,
): boolean {
  if (hasConsoleAccess(viewer.role)) return true
  if (booking.status === 'CONFIRMED') return true
  const email = (viewer.email || '').toLowerCase()
  if (!email) return false
  if ((booking.createdByEmail || '').toLowerCase() === email) return true
  if ((booking.producerEmail || '').toLowerCase() === email) return true
  return (booking.assignedEmails || []).some(e => (e || '').toLowerCase() === email)
}
