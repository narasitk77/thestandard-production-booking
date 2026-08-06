// v1.166 — who gets asked to review whom. The rules here decide whether a
// person is ever asked to rate their own team (they must not be) and whether a
// pointless form goes out to a one-team shoot (it must not).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRater, presentRoles, buildInvites, newInviteToken, tokenFingerprint,
  isCriterionKey, reviewDelayDays, REVIEW_CRITERIA,
} from '../shoot-review'

const base = {
  id: 'b1', bookingCode: 'NWS-260817-01', shootDate: new Date('2026-08-17'),
  status: 'CONFIRMED', deletedAt: null,
  producerEmail: 'pd@thestandard.co', createdByEmail: 'pd@thestandard.co',
  assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co'],
  mainVideographerEmail: 'cam@thestandard.co',
  crewRequired: ['Videographer', 'Sound'],
}
const roster = { 'cam@thestandard.co': 'video', 'snd@thestandard.co': 'sound', 'pd@thestandard.co': 'producer' }

test('everyone is asked about the OTHER teams and never about their own', () => {
  const invites = buildInvites(base, roster)
  const byEmail = Object.fromEntries(invites.map(i => [i.email, i]))
  assert.deepEqual(byEmail['pd@thestandard.co'].targets, ['camera', 'sound'])
  assert.deepEqual(byEmail['cam@thestandard.co'].targets, ['producer', 'sound'])
  assert.deepEqual(byEmail['snd@thestandard.co'].targets, ['producer', 'camera'])
  for (const i of invites) assert.ok(!i.targets.includes(i.role as any), `${i.email} rates own team`)
})

test('review is mutual — the camera team really does rate the producer back', () => {
  const cam = buildInvites(base, roster).find(i => i.email === 'cam@thestandard.co')!
  assert.ok(cam.targets.includes('producer'))
})

test('a shoot with only one team gets NO invites (nobody to rate)', () => {
  const soloBooking = {
    ...base, assignedEmails: [], mainVideographerEmail: null,
    crewRequired: [], producerEmail: 'pd@thestandard.co', createdByEmail: 'pd@thestandard.co',
  }
  assert.deepEqual(buildInvites(soloBooking, roster), [])
})

test('cancelled and deleted bookings are never surveyed', () => {
  assert.deepEqual(buildInvites({ ...base, status: 'CANCELLED' }, roster), [])
  assert.deepEqual(buildInvites({ ...base, deletedAt: new Date() }, roster), [])
})

test('a booking with nobody assigned produces nothing', () => {
  assert.deepEqual(buildInvites({
    ...base, assignedEmails: [], mainVideographerEmail: null,
    producerEmail: null, createdByEmail: null,
  }, roster), [])
})

test('rater classification: producer / main videographer / roster role / unknown', () => {
  const b = { producerEmail: 'pd@x', createdByEmail: 'maker@x', mainVideographerEmail: 'cam@x' }
  assert.equal(classifyRater('pd@x', b, {}), 'producer')
  assert.equal(classifyRater('maker@x', b, {}), 'producer')
  assert.equal(classifyRater('cam@x', b, {}), 'camera')
  assert.equal(classifyRater('s@x', b, { 's@x': 'sound' }), 'sound')
  assert.equal(classifyRater('p@x', b, { 'p@x': 'photo' }), 'camera')   // photo counts as camera side
  assert.equal(classifyRater('d@x', b, { 'd@x': 'director' }), 'camera')
  assert.equal(classifyRater('who@x', b, {}), 'other')
  assert.equal(classifyRater('  PD@X  ', b, {}), 'producer')            // trims + lowercases
})

test('an "other" role still rates every team present, and is rated by none', () => {
  const invites = buildInvites({ ...base, assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co', 'x@thestandard.co'] }, roster)
  const other = invites.find(i => i.email === 'x@thestandard.co')!
  assert.equal(other.role, 'other')
  assert.deepEqual(other.targets, ['producer', 'camera', 'sound'])
})

test('sound is a target when the job requested Sound even if nobody was tagged yet', () => {
  assert.ok(presentRoles({ crewRequired: ['Sound'], producerEmail: 'p@x', createdByEmail: null }, ['producer']).includes('sound'))
  assert.ok(!presentRoles({ crewRequired: [], producerEmail: 'p@x', createdByEmail: null }, ['producer']).includes('sound'))
})

test('target order is stable so the form never reshuffles between people', () => {
  assert.deepEqual(presentRoles({ crewRequired: ['Sound'], producerEmail: 'p@x', createdByEmail: null }, ['camera', 'sound']),
    ['producer', 'camera', 'sound'])
})

test('tokens are long, unique, and never logged raw (fingerprint is short + stable)', () => {
  const a = newInviteToken(), b = newInviteToken()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40, `token too short: ${a.length}`)
  assert.doesNotMatch(a, /[+/=]/) // url-safe: survives an email client
  assert.equal(tokenFingerprint(a), tokenFingerprint(a))
  assert.equal(tokenFingerprint(a).length, 12)
  assert.notEqual(tokenFingerprint(a), a.slice(0, 12)) // fingerprint ≠ prefix of the secret
})

test('the send delay defaults to 1 day and ignores junk env', () => {
  const saved = process.env.SHOOT_REVIEW_DELAY_DAYS
  delete process.env.SHOOT_REVIEW_DELAY_DAYS
  assert.equal(reviewDelayDays(), 1)
  process.env.SHOOT_REVIEW_DELAY_DAYS = 'abc'
  assert.equal(reviewDelayDays(), 1)
  process.env.SHOOT_REVIEW_DELAY_DAYS = '3'
  assert.equal(reviewDelayDays(), 3)
  if (saved === undefined) delete process.env.SHOOT_REVIEW_DELAY_DAYS
  else process.env.SHOOT_REVIEW_DELAY_DAYS = saved
})

test('criteria keys validate and every one has Thai copy', () => {
  for (const c of REVIEW_CRITERIA) { assert.equal(isCriterionKey(c.key), true); assert.ok(c.th) }
  assert.equal(isCriterionKey('vibes'), false)
})

// ── v1.166.1 — fixes from the pre-deploy adversarial review ──────────────────

test('the person who merely FILED the booking is not surveyed', () => {
  // Coordinators file bookings for other people and never go on set. Inviting
  // them made the survey feel like it was spamming the whole company.
  const invites = buildInvites({
    ...base, createdByEmail: 'coordinator@thestandard.co',
    producerEmail: 'pd@thestandard.co',
  }, roster)
  assert.equal(invites.some(i => i.email === 'coordinator@thestandard.co'), false)
  assert.equal(invites.some(i => i.email === 'pd@thestandard.co'), true)
})

test('a filer who is ALSO crew still gets asked (they were actually there)', () => {
  const invites = buildInvites({
    ...base, createdByEmail: 'cam@thestandard.co',
  }, roster)
  assert.equal(invites.some(i => i.email === 'cam@thestandard.co'), true)
})

test('invite targets are what the email promised — they are stored, not recomputed', () => {
  // The bug: the form recomputed the target list from ONE rater's role, so the
  // camera team could never appear and the producer was asked less than the
  // email said. buildInvites is the single decision point; its output is what
  // gets persisted on the invite row.
  const invites = buildInvites(base, roster)
  for (const i of invites) {
    assert.ok(i.targets.length > 0, `${i.email} got an empty target list`)
    assert.ok(!i.targets.includes(i.role as any))
  }
  const cam = invites.find(i => i.email === 'cam@thestandard.co')!
  assert.deepEqual(cam.targets, ['producer', 'sound'])
})
