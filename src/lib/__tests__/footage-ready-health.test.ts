/**
 * v1.181 — the outcome check for footage-ready. Every case here is a shape the
 * real system produced: the five-week `admin`-only run, the freelancer-filtered
 * team list, the aged-out bookings nobody was ever told about.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeSends, bucketPending, footageReadyAlerts, ADMIN_DIGEST, COLD_AFTER_MS,
  type SendRow, type PendingBooking,
} from '../footage-ready-health'

const T0 = new Date('2026-08-20T05:00:00Z')
const daysAgo = (n: number) => new Date(T0.getTime() - n * 86_400_000)
const row = (code: string, at: Date, recipients: string[]): SendRow => ({ bookingCode: code, at, recipients })

// ── summarizeSends ──────────────────────────────────────────────────────────

test('digest-only sends count as reaching NOBODY on the job', () => {
  const s = summarizeSends([
    row('A-1', daysAgo(2), [ADMIN_DIGEST]),
    row('A-2', daysAgo(1), [ADMIN_DIGEST]),
  ])
  assert.equal(s.total, 2)
  assert.equal(s.toTeam, 0, 'this is exactly the state that read green for five weeks')
  assert.equal(s.adminOnly, 2)
  assert.equal(s.peopleReached, 0)
  assert.equal(s.lastToTeamAt, null)
})

test('a real mailbox alongside the digest counts as reaching the team', () => {
  const s = summarizeSends([row('A-1', T0, ['producer@thestandard.co', ADMIN_DIGEST])])
  assert.equal(s.toTeam, 1)
  assert.equal(s.adminOnly, 0)
  assert.equal(s.peopleReached, 1)
  assert.equal(s.lastToTeamAt, T0.toISOString())
})

test('people are counted once across the window, case/space insensitively', () => {
  const s = summarizeSends([
    row('A-1', daysAgo(3), ['Video@thestandard.co', ' sound@thestandard.co ']),
    row('A-2', daysAgo(1), ['video@thestandard.co', 'crew@thestandard.co']),
  ])
  assert.equal(s.peopleReached, 3)
})

test('empty recipient list (no producer email, warning path) is not a team send', () => {
  const s = summarizeSends([row('A-1', T0, [])])
  assert.deepEqual([s.total, s.toTeam, s.adminOnly], [1, 0, 1])
})

test('non-address junk never counts as a recipient', () => {
  const s = summarizeSends([row('A-1', T0, ['—', 'ไม่มี', ADMIN_DIGEST])])
  assert.equal(s.toTeam, 0)
  assert.equal(s.peopleReached, 0)
})

test('lastAt tracks the newest row regardless of input order', () => {
  const s = summarizeSends([
    row('A-2', daysAgo(1), [ADMIN_DIGEST]),
    row('A-1', daysAgo(5), ['p@thestandard.co']),
  ])
  assert.equal(s.lastAt, daysAgo(1).toISOString())
  assert.equal(s.lastToTeamAt, daysAgo(5).toISOString(), 'the team has not heard anything for 5 days')
})

test('no sends at all: zeros, not NaN', () => {
  const s = summarizeSends([])
  assert.deepEqual(s, { total: 0, toTeam: 0, adminOnly: 0, peopleReached: 0, lastAt: null, lastToTeamAt: null })
})

// ── bucketPending ───────────────────────────────────────────────────────────

const p = (code: string, endDaysAgo: number, fileCount: number, walked: Date | null): PendingBooking =>
  ({ bookingCode: code, windowDate: daysAgo(endDaysAgo), fileCount, walkedAt: walked })

test('footage on Drive inside the window is waiting; outside it is aged out', () => {
  const b = bucketPending([p('IN-1', 2, 120, daysAgo(1)), p('OUT-1', 9, 300, daysAgo(8))], T0, 4)
  assert.deepEqual(b.waiting, ['IN-1'])
  assert.deepEqual(b.agedOut, ['OUT-1'], 'the auto path will never look at this one again')
})

test('the lookback boundary comes from the worker env, not a constant', () => {
  const rows = [p('EDGE', 5, 50, daysAgo(4))]
  assert.deepEqual(bucketPending(rows, T0, 3).agedOut, ['EDGE'])
  assert.deepEqual(bucketPending(rows, T0, 7).waiting, ['EDGE'], 'same booking, wider window → still recoverable')
})

test('never-walked shoots are their own bucket (the starvation symptom)', () => {
  const b = bucketPending([p('COLD', 1, 0, null)], T0, 4)
  assert.deepEqual(b.neverWalked, ['COLD'])
  assert.deepEqual(b.waiting, [])
})

test('walked and genuinely empty is NOT an alert — footage simply is not there yet', () => {
  const b = bucketPending([p('EMPTY', 1, 0, daysAgo(0))], T0, 4)
  assert.deepEqual(b, { waiting: [], agedOut: [], neverWalked: [] })
})

test('a job the sweep skips by design is never "starved" — it is skipped forever', () => {
  // WLT-OTH-260819-01: Photo Album, lighting for ID photos. readyCheckedAt stays
  // null for the life of the booking, so the naive rule nags every single run.
  const b = bucketPending(
    [{ bookingCode: 'WLT-OTH-260819-01', windowDate: daysAgo(1), fileCount: 0, walkedAt: null, skippedByDesign: true }],
    T0, 4,
  )
  assert.deepEqual(b.neverWalked, [])
})

test('but a skipped job that DOES have footage still gets mailed about', () => {
  const b = bucketPending(
    [{ bookingCode: 'SKIP-BUT-FILES', windowDate: daysAgo(1), fileCount: 40, walkedAt: daysAgo(1), skippedByDesign: true }],
    T0, 4,
  )
  assert.deepEqual(b.waiting, ['SKIP-BUT-FILES'])
})

test('a shoot that wrapped hours ago is young, not starved (crew may still be uploading)', () => {
  const justWrapped = new Date(T0.getTime() - 3 * 60 * 60_000)
  const b = bucketPending([{ bookingCode: 'FRESH', windowDate: justWrapped, fileCount: 0, walkedAt: null }], T0, 4)
  assert.deepEqual(b.neverWalked, [], 'inside COLD_AFTER_MS')
  const later = new Date(T0.getTime() + COLD_AFTER_MS)
  const b2 = bucketPending([{ bookingCode: 'FRESH', windowDate: justWrapped, fileCount: 0, walkedAt: null }], later, 4)
  assert.deepEqual(b2.neverWalked, ['FRESH'], 'still un-walked a day later = starvation')
})

test('never-walked but already past the window is not reported as cold', () => {
  const b = bucketPending([p('GONE', 10, 0, null)], T0, 3)
  assert.deepEqual(b.neverWalked, [], 'nothing to walk any more; and with no footage seen it is not an aged-out loss either')
})

test('a missing booking code degrades to a label instead of crashing', () => {
  const b = bucketPending([{ bookingCode: null, windowDate: daysAgo(1), fileCount: 5, walkedAt: null }], T0, 4)
  assert.deepEqual(b.waiting, ['(no code)'])
})

test('multi-day shoot: the LAST day decides, so a long job is not declared lost', () => {
  // Day 1 was 6 days ago, wrap was yesterday, lookback 4 → the worker still has
  // it (its query ORs on shootEndDate), so this must read as waiting.
  const b = bucketPending([p('MULTI', 1, 900, daysAgo(1))], T0, 4)
  assert.deepEqual(b.waiting, ['MULTI'])
  assert.deepEqual(b.agedOut, [])
})

// ── footageReadyAlerts ──────────────────────────────────────────────────────

const base = {
  workerEnabled: true,
  audience: 'team',
  windowDays: 7,
  sends: summarizeSends([]),
  pending: { waiting: [], agedOut: [], neverWalked: [] },
  shootsOver: 0,
}

test('healthy: sends reached people, nothing stranded → silence', () => {
  const alerts = footageReadyAlerts({
    ...base,
    sends: summarizeSends([row('A-1', T0, ['p@thestandard.co', ADMIN_DIGEST])]),
    shootsOver: 3,
  })
  assert.deepEqual(alerts, [])
})

test('THE five-week bug: sends happened, none reached the job → red, names the env var', () => {
  const alerts = footageReadyAlerts({
    ...base,
    audience: 'admin',
    sends: summarizeSends([row('A-1', daysAgo(2), [ADMIN_DIGEST]), row('A-2', daysAgo(1), [ADMIN_DIGEST])]),
    shootsOver: 12,
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /🔴/)
  assert.match(alerts[0], /FOOTAGE_READY_AUDIENCE/)
  assert.match(alerts[0], /admin/)
})

test('worker off short-circuits — one clear line, no derived noise', () => {
  const alerts = footageReadyAlerts({ ...base, workerEnabled: false, shootsOver: 9, pending: { waiting: [], agedOut: ['X-1'], neverWalked: ['Y-1'] } })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /worker ปิดอยู่/)
})

test('silent window with shoots that ended is red', () => {
  const alerts = footageReadyAlerts({ ...base, shootsOver: 8 })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /ไม่มีการแจ้งอัตโนมัติออกไปเลย/)
})

test('quiet week with no shoots is not an alert', () => {
  assert.deepEqual(footageReadyAlerts({ ...base, shootsOver: 0 }), [])
})

test('aged-out bookings are listed by code so someone can press 📣', () => {
  const alerts = footageReadyAlerts({
    ...base,
    sends: summarizeSends([row('A-1', T0, ['p@thestandard.co'])]),
    shootsOver: 4,
    pending: { waiting: [], agedOut: ['TSS-TSS-260813-01', 'AGN-260813-01'], neverWalked: [] },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /TSS-TSS-260813-01, AGN-260813-01/)
})

test('partial digest-only sends are a yellow note, not a red alarm', () => {
  const alerts = footageReadyAlerts({
    ...base,
    sends: summarizeSends([row('A-1', T0, ['p@thestandard.co']), row('A-2', T0, [ADMIN_DIGEST])]),
    shootsOver: 2,
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /🟡/)
  assert.match(alerts[0], /1\/2/)
})

test('waiting bookings alone never alert — that is the system working', () => {
  const alerts = footageReadyAlerts({
    ...base,
    sends: summarizeSends([row('A-1', T0, ['p@thestandard.co'])]),
    shootsOver: 5,
    pending: { waiting: ['W-1', 'W-2'], agedOut: [], neverWalked: [] },
  })
  assert.deepEqual(alerts, [])
})
