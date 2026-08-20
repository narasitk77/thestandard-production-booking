/**
 * Footage-ready auto-notify (v1.147) — pure settle logic.
 * The Drive I/O + send paths are exercised via the dryRun endpoint; here we lock
 * down the settle predicate the notify/no-notify decision hinges on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSettle, footageReadyRecipients, parseReadySnapshot } from '../footage-ready'

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

// ── Recipients (v1.178) ─────────────────────────────────────────────────────
// The complaint that produced these: every "footage พร้อม" mail went to the
// operator and nobody else, because prod runs FOOTAGE_READY_AUDIENCE=admin.
// The trap in the obvious fix is that flipping to 'everyone' would have taken
// HIS copy away, so the tests pin "team as well", not "team instead".

const ADMIN = 'narasit.k@thestandard.co'
const BK = {
  producerEmail: 'Prae@thestandard.co',
  createdByEmail: 'coordinator@thestandard.co',
  assignedEmails: ['video@thestandard.co', 'sound@thestandard.co', 'freelance.jack@gmail.com'],
}

test('audience=admin: digest only, nobody on the team is mailed', () => {
  const r = footageReadyRecipients('admin', BK, ADMIN)
  assert.deepEqual(r, { people: [], digest: true })
})

test('audience=producer: the producer, plus the admin digest alongside', () => {
  const r = footageReadyRecipients('producer', BK, ADMIN)
  assert.deepEqual(r.people, ['prae@thestandard.co'], 'lower-cased and trimmed')
  assert.equal(r.digest, true, 'the operator keeps his copy — "ด้วย", not "แทน"')
})

test('audience=everyone: producer + creator + crew, freelancers included', () => {
  const r = footageReadyRecipients('everyone', BK, ADMIN)
  assert.deepEqual(r.people, [
    'prae@thestandard.co',
    'coordinator@thestandard.co',
    'video@thestandard.co',
    'sound@thestandard.co',
    'freelance.jack@gmail.com',
  ])
  assert.equal(r.digest, true)
})

test('admin already on the booking: no digest, so he is not mailed twice', () => {
  const r = footageReadyRecipients('everyone', { ...BK, producerEmail: ADMIN }, ADMIN)
  assert.ok(r.people.includes(ADMIN))
  assert.equal(r.digest, false)
})

test('admin match ignores case and padding (a duplicate would still be a duplicate)', () => {
  const r = footageReadyRecipients('producer', { producerEmail: '  NARASIT.K@thestandard.co ' }, ADMIN)
  assert.deepEqual(r.people, [ADMIN])
  assert.equal(r.digest, false)
})

test('no admin address configured: never invent one', () => {
  const r = footageReadyRecipients('everyone', BK, '')
  assert.equal(r.digest, false)
  assert.ok(r.people.length > 0, 'the team is still mailed')
})

test('junk and duplicate addresses are dropped, order preserved', () => {
  const r = footageReadyRecipients('everyone', {
    producerEmail: 'prae@thestandard.co',
    createdByEmail: '—',                       // the UI writes an em-dash for "none"
    assignedEmails: ['PRAE@thestandard.co', '', null as unknown as string, 'video@thestandard.co'],
  }, ADMIN)
  assert.deepEqual(r.people, ['prae@thestandard.co', 'video@thestandard.co'])
})

test('a booking with nobody on it yields nobody — the caller warns the admin instead', () => {
  const r = footageReadyRecipients('everyone', { producerEmail: null, createdByEmail: null, assignedEmails: [] }, ADMIN)
  assert.deepEqual(r.people, [])
  assert.equal(r.digest, true)
})
