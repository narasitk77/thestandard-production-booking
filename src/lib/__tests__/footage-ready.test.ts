/**
 * Footage-ready auto-notify (v1.147) — pure settle logic.
 * The Drive I/O + send paths are exercised via the dryRun endpoint; here we lock
 * down the settle predicate the notify/no-notify decision hinges on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSettle, footageReadyRecipients, isInternalEmail, orderForWalk, parseReadySnapshot } from '../footage-ready'

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

// ── audience=team (v1.179) ──────────────────────────────────────────────────
// Operator's call: notify the team but NOT the freelancers' personal addresses.

test('audience=team: staff only — the freelancer gmail is dropped', () => {
  const r = footageReadyRecipients('team', BK, ADMIN)
  assert.deepEqual(r.people, [
    'prae@thestandard.co',
    'coordinator@thestandard.co',
    'video@thestandard.co',
    'sound@thestandard.co',
  ], 'shared boxes stay — that IS how the camera team is reached')
  assert.equal(r.digest, true)
})

test('isInternalEmail: a malformed address fails the domain rule, never slips through it', () => {
  assert.equal(isInternalEmail('a@thestandard.co'), true)
  assert.equal(isInternalEmail('  A@THESTANDARD.CO '), true)
  assert.equal(isInternalEmail('a@b@thestandard.co'), false, 'splitting on the LAST @ would read this as internal')
  assert.equal(isInternalEmail('a@gmail.com'), false)
  assert.equal(isInternalEmail('@thestandard.co'), false)
  assert.equal(isInternalEmail('nobody'), false)
  assert.equal(isInternalEmail(''), false)
})

test('team with a custom domain list', () => {
  assert.equal(isInternalEmail('x@partner.co', ['partner.co']), true)
  assert.equal(isInternalEmail('x@thestandard.co', ['partner.co']), false)
})

// ── orderForWalk (v1.179) ───────────────────────────────────────────────────
// The starvation bug: no orderBy + slice(0, MAX_PER_RUN) handed the walk budget
// to the same five rows every sweep. Proven on prod — three consecutive dry runs
// walked an identical five and deferred an identical four, and the five squatters
// were bookings that can never have footage, so they were never stamped and never
// moved. Everything behind them aged out of the window unwalked.

const row = (bookingCode: string, shootDate: string, readyCheckedAt: string | null) =>
  ({ bookingCode, shootDate: new Date(shootDate), readyCheckedAt: readyCheckedAt ? new Date(readyCheckedAt) : null })

test('never-walked bookings go to the very front', () => {
  const out = orderForWalk([
    row('WALKED-RECENTLY', '2026-08-19', '2026-08-20T09:00:00Z'),
    row('NEVER-WALKED', '2026-08-17', null),
  ])
  assert.deepEqual(out.map(r => r.bookingCode), ['NEVER-WALKED', 'WALKED-RECENTLY'])
})

test('among walked ones, least recently walked comes first', () => {
  const out = orderForWalk([
    row('B', '2026-08-19', '2026-08-20T09:00:00Z'),
    row('A', '2026-08-19', '2026-08-20T07:00:00Z'),
    row('C', '2026-08-19', '2026-08-20T08:00:00Z'),
  ])
  assert.deepEqual(out.map(r => r.bookingCode), ['A', 'C', 'B'])
})

test('tie on last-walked breaks to the NEWEST shoot — people wait for fresh footage', () => {
  const out = orderForWalk([
    row('OLD', '2026-08-14', null),
    row('NEW', '2026-08-19', null),
    row('MID', '2026-08-17', null),
  ])
  assert.deepEqual(out.map(r => r.bookingCode), ['NEW', 'MID', 'OLD'])
})

test('THE REGRESSION: a squatter that keeps finding no footage stops holding the queue', () => {
  // Sweep 1 — nothing has been walked yet, cap of 2. The two newest win.
  let rows = [
    row('TSN-DAILY-NEWS', '2026-08-19', null),   // never has footage
    row('EVENT', '2026-08-19', null),            // never has footage
    row('REAL-SHOOT-A', '2026-08-18', null),
    row('REAL-SHOOT-B', '2026-08-18', null),
  ]
  const CAP = 2
  const sweep1 = orderForWalk(rows).slice(0, CAP).map(r => r.bookingCode)
  assert.deepEqual(sweep1, ['TSN-DAILY-NEWS', 'EVENT'])

  // Those two are stamped even though the walk found nothing (that is the fix).
  rows = rows.map(r => sweep1.includes(r.bookingCode as string)
    ? { ...r, readyCheckedAt: new Date('2026-08-20T09:00:00Z') } : r)

  // Sweep 2 — the real shoots now get the budget instead of being starved again.
  const sweep2 = orderForWalk(rows).slice(0, CAP).map(r => r.bookingCode)
  assert.deepEqual(sweep2, ['REAL-SHOOT-A', 'REAL-SHOOT-B'])
  assert.ok(!sweep2.some(c => sweep1.includes(c as string)), 'no booking is walked twice before every other has had a turn')
})

test('orderForWalk does not mutate its input', () => {
  const rows = [row('B', '2026-08-14', null), row('A', '2026-08-19', null)]
  const before = rows.map(r => r.bookingCode)
  orderForWalk(rows)
  assert.deepEqual(rows.map(r => r.bookingCode), before)
})
