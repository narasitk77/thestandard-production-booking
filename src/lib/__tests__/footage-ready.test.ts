/**
 * Footage-ready auto-notify (v1.147) — pure settle logic.
 * The Drive I/O + send paths are exercised via the dryRun endpoint; here we lock
 * down the settle predicate the notify/no-notify decision hinges on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSettle, parseReadySnapshot } from '../footage-ready'

const T0 = new Date('2026-07-14T10:00:00Z')
const mins = (n: number) => new Date(T0.getTime() + n * 60_000)
const SETTLE = 60 * 60_000 // 60 min

test('first sighting: not settled, writes a fresh snapshot with now-timestamp', () => {
  const d = evaluateSettle({ fileCount: 10, totalBytes: 5000 }, null, T0, SETTLE)
  assert.equal(d.settled, false)
  assert.deepEqual(d.write, { fileCount: 10, totalBytes: 5000, at: T0.toISOString() })
})

test('counts unchanged but young: keeps waiting WITHOUT rewriting the snapshot (timer keeps running)', () => {
  const snap = { fileCount: 10, totalBytes: 5000, at: T0.toISOString() }
  const d = evaluateSettle({ fileCount: 10, totalBytes: 5000 }, snap, mins(30), SETTLE)
  assert.equal(d.settled, false)
  assert.equal(d.write, null, 'no write — the original `at` must keep aging')
})

test('counts unchanged past the settle window: SETTLED', () => {
  const snap = { fileCount: 10, totalBytes: 5000, at: T0.toISOString() }
  const d = evaluateSettle({ fileCount: 10, totalBytes: 5000 }, snap, mins(60), SETTLE)
  assert.equal(d.settled, true)
  assert.equal(d.write, null)
})

test('counts CHANGED (new batch arrived): timer restarts with the new counts', () => {
  const snap = { fileCount: 10, totalBytes: 5000, at: T0.toISOString() }
  const d = evaluateSettle({ fileCount: 25, totalBytes: 9000 }, snap, mins(90), SETTLE)
  assert.equal(d.settled, false, 'even though 90min passed, counts moved — not settled')
  assert.deepEqual(d.write, { fileCount: 25, totalBytes: 9000, at: mins(90).toISOString() })
})

test('byte-count change alone (same fileCount) also restarts the timer', () => {
  const snap = { fileCount: 10, totalBytes: 5000, at: T0.toISOString() }
  const d = evaluateSettle({ fileCount: 10, totalBytes: 7777 }, snap, mins(120), SETTLE)
  assert.equal(d.settled, false)
  assert.equal(d.write?.totalBytes, 7777)
})

test('parseReadySnapshot: valid blob round-trips', () => {
  const s = { fileCount: 3, totalBytes: 123, at: T0.toISOString() }
  assert.deepEqual(parseReadySnapshot(s), s)
})

test('parseReadySnapshot: malformed blobs → null (timer restarts safely)', () => {
  assert.equal(parseReadySnapshot(null), null)
  assert.equal(parseReadySnapshot(undefined), null)
  assert.equal(parseReadySnapshot('junk'), null)
  assert.equal(parseReadySnapshot({ fileCount: '3', totalBytes: 1, at: T0.toISOString() }), null)
  assert.equal(parseReadySnapshot({ fileCount: 3, totalBytes: 1 }), null)
  assert.equal(parseReadySnapshot({ fileCount: 3, totalBytes: 1, at: 'not-a-date' }), null)
})
