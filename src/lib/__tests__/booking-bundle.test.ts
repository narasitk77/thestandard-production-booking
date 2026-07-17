/**
 * v1.148 — validateBundleLink: the guard for linking a shoot's footage box into
 * a "home" booking. Pure — the Drive move is integration-tested against the live
 * endpoint; here we lock down the accept/reject rules.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBundleLink } from '../booking-bundle'

const bk = (over: Partial<any> = {}) => ({
  id: 'child', bookingCode: 'NWS-KYM-260718-01', deletedAt: null,
  outlet: { code: 'NWS' }, episodes: [{ program: { code: 'KYM' } }], bundleParentId: null,
  ...over,
}) as any

const parent = (over: Partial<any> = {}) => bk({ id: 'parent', bookingCode: 'NWS-KYM-260801-01', ...over })

test('happy path: two normal non-AGN bookings link', () => {
  assert.deepEqual(validateBundleLink(bk(), parent(), 0), { ok: true })
})

test('cannot link a booking to itself', () => {
  const r = validateBundleLink(bk({ id: 'x' }), parent({ id: 'x' }), 0)
  assert.equal(r.ok, false)
})

test('rejects deleted child or parent', () => {
  assert.equal(validateBundleLink(bk({ deletedAt: new Date() }), parent(), 0).ok, false)
  assert.equal(validateBundleLink(bk(), parent({ deletedAt: new Date() }), 0).ok, false)
})

test('rejects when either lacks a Production ID', () => {
  assert.equal(validateBundleLink(bk({ bookingCode: null }), parent(), 0).ok, false)
  assert.equal(validateBundleLink(bk(), parent({ bookingCode: null }), 0).ok, false)
})

test('AGN is rejected (shares a project box already)', () => {
  assert.equal(validateBundleLink(bk({ outlet: { code: 'AGN' } }), parent(), 0).ok, false)
  assert.equal(validateBundleLink(bk(), parent({ outlet: { code: 'AGN' } }), 0).ok, false)
})

test('photo-album bookings are rejected (different drive)', () => {
  const photo = { episodes: [{ program: { code: 'A' } }] }
  assert.equal(validateBundleLink(bk(photo), parent(), 0).ok, false)
  assert.equal(validateBundleLink(bk(), parent(photo), 0).ok, false)
})

test('home must be a root — a parent that is itself a child is rejected', () => {
  const r = validateBundleLink(bk(), parent({ bundleParentId: 'someone-else' }), 0)
  assert.equal(r.ok, false)
})

test('child that is itself a home (has children) is rejected', () => {
  const r = validateBundleLink(bk(), parent(), 2)
  assert.equal(r.ok, false)
})
