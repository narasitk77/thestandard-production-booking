// v1.167 — the lease is the ONLY thing stopping two reconcile passes from
// writing the same Drive tree at once. The pure staleness rule is pinned here;
// the CAS itself is exercised against Postgres in the route's own dry-run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLeaseStale, LEASE_TTL_MS, LEASE_RENEW_INTERVAL_MS,
  PASS_LEASE_KEY, bookingLeaseKey,
} from '../reconciler/lease'

const now = new Date('2026-08-07T10:00:00.000Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

test('a lease renewed just now is NOT claimable by anyone else', () => {
  assert.equal(isLeaseStale(ago(0), now), false)
  assert.equal(isLeaseStale(ago(1_000), now), false)
})

test('a long-running pass keeps its lease as long as it renews', () => {
  // The bug a duration-based guard would cause: a legitimate 20-minute pass
  // (seven workers of Drive work + 429 backoff) would lose its lease mid-write
  // and a second pass would start on the same folders.
  assert.equal(isLeaseStale(ago(LEASE_RENEW_INTERVAL_MS), now), false)
  assert.equal(isLeaseStale(ago(LEASE_TTL_MS - 1), now), false)
})

test('a lease whose holder stopped renewing becomes claimable at the TTL', () => {
  // This is the crash-release path: process dies → renewals stop → the next
  // tick takes over. No lock survives a restart.
  assert.equal(isLeaseStale(ago(LEASE_TTL_MS), now), true)
  assert.equal(isLeaseStale(ago(LEASE_TTL_MS + 60_000), now), true)
})

test('a missing lease row is claimable', () => {
  assert.equal(isLeaseStale(null, now), true)
  assert.equal(isLeaseStale(undefined, now), true)
})

test('the TTL leaves real headroom over the renewal interval', () => {
  // If these ever converge, a single slow renewal (one 429 backoff) drops the
  // lease under a healthy pass.
  assert.ok(LEASE_TTL_MS >= 4 * LEASE_RENEW_INTERVAL_MS,
    `TTL ${LEASE_TTL_MS} must be >= 4x renew interval ${LEASE_RENEW_INTERVAL_MS}`)
})

test('lease keys are distinct per scope so a booking button cannot block the pass', () => {
  assert.notEqual(bookingLeaseKey('NWS-260817-01'), PASS_LEASE_KEY)
  assert.notEqual(bookingLeaseKey('A-1'), bookingLeaseKey('A-2'))
  assert.match(bookingLeaseKey('NWS-260817-01'), /NWS-260817-01$/)
})
