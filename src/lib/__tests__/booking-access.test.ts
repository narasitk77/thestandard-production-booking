/**
 * canViewBooking — read-scope for GET /api/bookings/[id] (v1.50.1).
 * Console tiers see everything; everyone else must be on the booking
 * (requester / producer / assigned crew), compared case-insensitively.
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

test('plain USER can view only bookings they are on (case-insensitive)', () => {
  assert.equal(canViewBooking({ email: 'requester@thestandard.co', role: 'USER' }, booking), true)
  assert.equal(canViewBooking({ email: 'producer@thestandard.co', role: 'USER' }, booking), true)
  assert.equal(canViewBooking({ email: 'crew.one@thestandard.co', role: 'USER' }, booking), true)
  assert.equal(canViewBooking({ email: 'stranger@thestandard.co', role: 'USER' }, booking), false)
})

test('null/empty fields never match', () => {
  const bare = { createdByEmail: null, producerEmail: null, assignedEmails: [] }
  assert.equal(canViewBooking({ email: 'anyone@thestandard.co', role: 'USER' }, bare), false)
  assert.equal(canViewBooking({ email: '', role: 'USER' }, booking), false)
  // '' vs null createdByEmail must not match ('' === '' without the guard)
  assert.equal(canViewBooking({ email: '', role: 'USER' }, bare), false)
})

test('v1.131 — a CONFIRMED booking is viewable by anyone (matches list visibility)', () => {
  const confirmed = { ...booking, status: 'CONFIRMED' }
  assert.equal(canViewBooking({ email: 'stranger@thestandard.co', role: 'USER' }, confirmed), true)
  // a non-CONFIRMED booking (REQUESTED/ASSIGNED/etc.) is unaffected — still stranger-blocked
  const requested = { ...booking, status: 'REQUESTED' }
  assert.equal(canViewBooking({ email: 'stranger@thestandard.co', role: 'USER' }, requested), false)
})
