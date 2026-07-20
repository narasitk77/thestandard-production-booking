/**
 * v1.90 — tier resolution + page access. This gates who sees/opens what, so a
 * wrong line either locks a tier out of its own work or exposes the console.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTier, tierAllows, tierHome } from '../tiers'

test('resolveTier maps real role × position values', () => {
  assert.equal(resolveTier('ADMIN', 'Head of Video Director'), 'admin')
  assert.equal(resolveTier('MANAGER', 'Video Production Manager'), 'admin')
  assert.equal(resolveTier('SUPPORT', null), 'admin')
  // Senior Sound Engineer wins over the COORDINATOR role → sound-mgmt.
  assert.equal(resolveTier('COORDINATOR', 'Senior Sound Engineer'), 'sound-mgmt')
  assert.equal(resolveTier('COORDINATOR', 'Production Coordinator'), 'coordinator')
  // Producer + Co-Producer (USER) → producer.
  assert.equal(resolveTier('USER', 'Producer'), 'producer')
  assert.equal(resolveTier('USER', 'Co-Producer'), 'producer')
  // Everyone else (USER) → crew.
  assert.equal(resolveTier('USER', 'Videographer'), 'crew')
  assert.equal(resolveTier('USER', 'Sound Engineer'), 'crew')
  assert.equal(resolveTier('USER', 'Sound Recorder'), 'crew')
  assert.equal(resolveTier('USER', 'Switcher'), 'crew')
  assert.equal(resolveTier('USER', 'Video Editor'), 'crew')
  assert.equal(resolveTier('USER', null), 'crew')
})

test('tierAllows: admin opens everything', () => {
  for (const p of ['/', '/admin', '/admin/workspace', '/upload', '/producer', '/ot', '/anything']) {
    assert.equal(tierAllows('admin', p), true)
  }
})

test('tierAllows: producer = bookings/producer, not console/upload', () => {
  assert.equal(tierAllows('producer', '/my-bookings'), true)
  assert.equal(tierAllows('producer', '/producer'), true)
  assert.equal(tierAllows('producer', '/new'), true)
  assert.equal(tierAllows('producer', '/calendar'), true)
  assert.equal(tierAllows('producer', '/admin'), false)
  assert.equal(tierAllows('producer', '/upload'), false)
})

test('tierAllows: every tier can open its OWN booking detail + self-edit (v1.92.1 lockout fix)', () => {
  // /dashboard/[id] and /bookings/[id]/edit are linked from /my-bookings and
  // authorize by owner server-side — the tier gate must NOT bounce them.
  for (const tier of ['producer', 'crew', 'coordinator', 'sound-mgmt'] as const) {
    assert.equal(tierAllows(tier, '/dashboard/cmq123'), true, `${tier} → /dashboard/[id]`)
    assert.equal(tierAllows(tier, '/bookings/cmq123/edit'), true, `${tier} → /bookings/[id]/edit`)
  }
})

test('tierAllows: crew = upload job task, not the console', () => {
  assert.equal(tierAllows('crew', '/upload'), true)
  assert.equal(tierAllows('crew', '/upload?bookingId=x'.split('?')[0]), true)
  assert.equal(tierAllows('crew', '/my-bookings'), true)
  assert.equal(tierAllows('crew', '/admin'), false)
})

test('tierAllows: /producer is open to every tier (v1.148.2 — producing is a role-on-booking, not a job title)', () => {
  // 9 real producers (assistants/creators/PMs, e.g. aphisit.h with 16 bookings)
  // sat in the crew tier and couldn't reach /producer to send edit requests.
  // The page scopes all data by the session's own producerEmail, so this is safe.
  for (const tier of ['crew', 'producer', 'coordinator', 'sound-mgmt', 'admin'] as const) {
    assert.equal(tierAllows(tier, '/producer'), true, `${tier} must reach /producer`)
  }
})

test('tierAllows: every signed-in tier can open /new (the booking wizard is for everyone)', () => {
  // /new + POST /api/bookings are session-only; blocking the crew tier trapped
  // brand-new users with no way to request a booking. Regression for that.
  for (const tier of ['crew', 'producer', 'coordinator', 'sound-mgmt', 'admin'] as const) {
    assert.equal(tierAllows(tier, '/new'), true, `${tier} → /new`)
  }
})

test('tierAllows: every tier reaches /booking/success + /ot (layouts do the real gating)', () => {
  // After submitting the wizard, every tier must see the success/confirmation
  // screen at /booking/success (singular /booking). /ot is self-service overtime
  // for the whole roster (ot/layout.tsx gates to team members + approvers).
  for (const tier of ['crew', 'producer', 'coordinator', 'sound-mgmt', 'admin'] as const) {
    assert.equal(tierAllows(tier, '/booking/success'), true, `${tier} → /booking/success`)
    assert.equal(tierAllows(tier, '/ot'), true, `${tier} → /ot`)
    assert.equal(tierAllows(tier, '/ot/admin'), true, `${tier} → /ot/admin`)
  }
})

test('tierAllows: sound-mgmt = queue only, not the console tools', () => {
  assert.equal(tierAllows('sound-mgmt', '/admin'), true)
  assert.equal(tierAllows('sound-mgmt', '/admin/abc123'), true) // booking detail
  assert.equal(tierAllows('sound-mgmt', '/admin/workspace'), false)
  assert.equal(tierAllows('sound-mgmt', '/admin/routine'), false)
  assert.equal(tierAllows('sound-mgmt', '/admin/upload-review'), false)
  assert.equal(tierAllows('sound-mgmt', '/upload'), true) // sound engineers upload sound footage
})

test('tierAllows: coordinator = the booking queue + crew tools', () => {
  assert.equal(tierAllows('coordinator', '/admin'), true)
  assert.equal(tierAllows('coordinator', '/admin/workspace'), true)
  assert.equal(tierAllows('coordinator', '/upload'), true)
  assert.equal(tierAllows('coordinator', '/ot'), true)
})

test('tierHome targets each tier’s main surface', () => {
  assert.equal(tierHome('crew'), '/upload')
  assert.equal(tierHome('producer'), '/my-bookings')
  assert.equal(tierHome('sound-mgmt'), '/admin')
  assert.equal(tierHome('admin'), '/')
  assert.equal(tierHome('coordinator'), '/')
})
