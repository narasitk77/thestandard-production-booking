/**
 * canViewBooking — read-scope for GET /api/bookings/[id].
 *
 * v1.152 — TRANSPARENT SCHEDULE. Any signed-in user may open any live booking,
 * because the list/calendar now show every booking regardless of status. The
 * older rule (console + people on the booking + CONFIRMED-for-everyone) is gone
 * on purpose: it is what made a booking visible on the calendar but "Forbidden"
 * on click-through (the v1.131 bug), and with REQUESTED shoots now on the
 * calendar that mismatch would hit far more people.
 *
 * Still enforced elsewhere, NOT here: soft-deleted bookings 404 for non-ADMIN in
 * the route, and every mutation keeps its own owner/console check.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canViewBooking } from '../booking-access'

const booking = {
  createdByEmail: 'Requester@thestandard.co',
  producerEmail: 'producer@thestandard.co',
  assignedEmails: ['Crew.One@thestandard.co', 'crew.two@thestandard.co'],
}

test('console tiers can view any booking', () => {
  for (const role of ['ADMIN', 'SUPPORT', 'MANAGER', 'COORDINATOR']) {
    assert.equal(canViewBooking({ email: 'someone@thestandard.co', role }, booking), true)
  }
})

test('v1.152 — any signed-in user can view any booking, in any status', () => {
  const stranger = { email: 'stranger@thestandard.co', role: 'USER' }
  assert.equal(canViewBooking(stranger, booking), true)
  for (const status of ['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']) {
    assert.equal(canViewBooking(stranger, { ...booking, status }), true)
  }
  // people on the booking obviously still pass
  assert.equal(canViewBooking({ email: 'requester@thestandard.co', role: 'USER' }, booking), true)
  assert.equal(canViewBooking({ email: 'crew.one@thestandard.co', role: 'USER' }, booking), true)
})

test('a session without an email is still refused', () => {
  // getSession() always supplies one; this guards a malformed/absent session
  // from being treated as "signed in".
  assert.equal(canViewBooking({ email: '', role: 'USER' }, booking), false)
  assert.equal(canViewBooking({ email: '   ', role: 'USER' }, booking), false)
  const bare = { createdByEmail: null, producerEmail: null, assignedEmails: [] }
  assert.equal(canViewBooking({ email: '', role: 'USER' }, bare), false)
})
