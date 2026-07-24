// v1.154 — the id-first coverage gauge: counts folder resolves that fell back
// from the stored Drive id to the Production-ID name match (= backfill
// candidates). These tests pin the counting + the Discord formatting.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { noteResolve, snapshotIdFirst, formatIdFirstDigest } from '../id-first-metrics'

// The counters are module-level; clear them before each test by reading with reset.
beforeEach(() => { snapshotIdFirst(true) })

test('a stored-id resolve counts as a hit, a name fallback counts against the code', () => {
  noteResolve('video-merge', 'landing', 'AAA-01', true)   // fast path
  noteResolve('video-merge', 'landing', 'BBB-02', false)  // fell back
  noteResolve('video-merge', 'landing', 'CCC-03', false)  // fell back

  const s = snapshotIdFirst()
  assert.equal(s.totalHit, 1)
  assert.equal(s.totalFallback, 2)
  const b = s.buckets.find(x => x.key === 'video-merge:landing')!
  assert.equal(b.hit, 1)
  assert.equal(b.fallback, 2)
  assert.deepEqual(b.codes.sort(), ['BBB-02', 'CCC-03'])
})

test('a hit never records a booking code (only fallbacks are backfill candidates)', () => {
  noteResolve('sound-merge', 'staging', 'HIT-01', true)
  const b = snapshotIdFirst().buckets.find(x => x.key === 'sound-merge:staging')!
  assert.equal(b.hit, 1)
  assert.deepEqual(b.codes, [])
})

test('the same code falling back twice is counted twice but listed once', () => {
  noteResolve('video-merge', 'box', 'DUP-01', false)
  noteResolve('video-merge', 'box', 'DUP-01', false)
  const b = snapshotIdFirst().buckets.find(x => x.key === 'video-merge:box')!
  assert.equal(b.fallback, 2)
  assert.deepEqual(b.codes, ['DUP-01']) // Set dedupes
})

test('snapshot(reset) clears the counters', () => {
  noteResolve('video-merge', 'landing', 'X', false)
  assert.equal(snapshotIdFirst(true).totalFallback, 1)
  assert.equal(snapshotIdFirst().totalFallback, 0) // cleared by the reset above
})

test('buckets are ordered most-fallback-first', () => {
  noteResolve('video-merge', 'landing', 'a', false)
  noteResolve('sound-merge', 'box', 'b', false)
  noteResolve('sound-merge', 'box', 'c', false)
  const keys = snapshotIdFirst().buckets.map(b => b.key)
  assert.equal(keys[0], 'sound-merge:box') // 2 fallbacks sorts above 1
})

// ── digest formatting ────────────────────────────────────────────────────────

test('formatIdFirstDigest returns null when nothing was measured', () => {
  assert.equal(formatIdFirstDigest(snapshotIdFirst()), null)
})

test('formatIdFirstDigest reports 100% and a celebratory line when no fallback', () => {
  noteResolve('video-merge', 'landing', 'A', true)
  noteResolve('video-merge', 'box', 'A', true)
  const text = formatIdFirstDigest(snapshotIdFirst())!
  assert.match(text, /100%/)
  assert.doesNotMatch(text, /fallback \*\*/) // no per-bucket fallback line
})

test('formatIdFirstDigest lists only buckets that fell back, with the codes', () => {
  noteResolve('video-merge', 'landing', 'GOOD', true)   // pure hit → omitted from list
  noteResolve('video-merge', 'box', 'NEEDS-BACKFILL', false)
  const text = formatIdFirstDigest(snapshotIdFirst())!
  assert.match(text, /video-merge:box/)
  assert.match(text, /NEEDS-BACKFILL/)
  assert.doesNotMatch(text, /video-merge:landing/) // hit-only bucket not listed
  // 1 hit of 2 total → 50%
  assert.match(text, /50%/)
})

test('formatIdFirstDigest caps the code sample at 6 and shows a +N overflow', () => {
  for (let i = 0; i < 9; i++) noteResolve('sound-merge', 'staging', `C-${i}`, false)
  const text = formatIdFirstDigest(snapshotIdFirst())!
  assert.match(text, /\+3/) // 9 codes → 6 shown + "+3"
})
