/**
 * v1.181 — the outcome check for footage-ready. Every case here is a shape the
 * real system produced: the five-week `admin`-only run, the freelancer-filtered
 * team list, the aged-out bookings nobody was ever told about.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeSends, bucketPending, footageReadyAlerts, readHeld, sweptUntil, previewHeld, heldConfirmWarning, ADMIN_DIGEST, COLD_AFTER_MS,
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
  assert.deepEqual(b, { waiting: [], agedOut: [], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: [] })
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
  pending: { waiting: [], agedOut: [], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: [] },
  shootsOver: 0,
  checkDays: 30,
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
  const alerts = footageReadyAlerts({ ...base, workerEnabled: false, shootsOver: 9, pending: { waiting: [], agedOut: ['X-1'], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: ['Y-1'] } })
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

test('aged-out bookings are listed by code so someone can act on them', () => {
  const alerts = footageReadyAlerts({
    ...base,
    sends: summarizeSends([row('A-1', T0, ['p@thestandard.co'])]),
    shootsOver: 4,
    pending: { waiting: [], agedOut: ['TSS-TSS-260813-01', 'AGN-260813-01'], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: [] },
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
    pending: { waiting: ['W-1', 'W-2'], agedOut: [], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: [] },
  })
  assert.deepEqual(alerts, [])
})

// ── v1.186 — บันทึกต้องตรงกับผลจริง ไม่ใช่เจตนา ─────────────────────────────
//
// ของจริงบนพรอด (2026-08-21): 85 การแจ้งใน 30 วัน ทุกแถวมี 'admin-digest' ใน
// recipients และ emailError = null → /stats รายงานว่า operator ได้รับทุกครั้ง
// ขณะที่เจ้าตัวไม่ได้เมลเลยแม้ฉบับเดียว เพราะ digest เป็น From=To=อีเมลเดียวกัน
// ส่งผ่าน Gmail SMTP ของบัญชีตัวเอง จึงไม่เข้า Inbox
// (⚠️ 9 ต.ค. 2569: ข้อสรุปเรื่อง Inbox ผิด — เมลหาตัวเองเข้า Inbox ได้ · ความหมายของ summarizeSends ข้างล่างไม่เปลี่ยน)
//
// v1.186 จึงใส่ ADMIN_DIGEST เฉพาะเมื่อ notifyEmailDigest คืน true เท่านั้น เทสนี้
// ล็อกความหมายของ summarizeSends ไว้ว่า "แถวที่ไม่มี ADMIN_DIGEST = operator ไม่ได้ยิน"
test('แถวที่ digest ส่งไม่ผ่าน (ไม่มี ADMIN_DIGEST) ต้องไม่ถูกนับว่าถึง operator', () => {
  const at = new Date('2026-08-21T00:00:00Z')
  const s = summarizeSends([
    // ทีมได้ แต่ digest ล้ม → ยังนับ toTeam เพราะมีคนในงานได้ยิน
    { bookingCode: 'A', at, recipients: ['producer@thestandard.co'] },
    // ไม่มีใครได้เลย (digest ล้ม + ไม่มีคนในงาน) → adminOnly ไม่ใช่ toTeam
    { bookingCode: 'B', at, recipients: [] },
  ])
  assert.equal(s.total, 2)
  assert.equal(s.toTeam, 1)
  assert.equal(s.adminOnly, 1, 'แถวที่ว่างเปล่าต้องอ่านว่าไม่มีใครได้ยิน')
  assert.equal(s.peopleReached, 1)
})

test('ADMIN_DIGEST ยังไม่นับเป็นคนจริง แม้อยู่ในรายชื่อ', () => {
  const at = new Date('2026-08-21T00:00:00Z')
  const s = summarizeSends([{ bookingCode: 'C', at, recipients: [ADMIN_DIGEST] }])
  assert.equal(s.toTeam, 0, 'digest ไม่ใช่คนในงาน')
  assert.equal(s.adminOnly, 1)
  assert.equal(s.peopleReached, 0)
})

// ── v1.274 — aged out but the MEDIAPRO gate was holding it ──────────────────────
// Real case 27 ต.ค. 2569: WLT-MNW-261012-01 / NWS-GLF-261012-01 were reported as
// "ต้องกด 📣 เอง" — but 2–3 clips were missing, and the 📣 button does not run the
// MEDIAPRO gate: pressing it would have told the team the footage was ready.
const HELD = { detail: 'ขาด 2 ไฟล์ตาม MEDIAPRO (A014C001_261013XU.MP4, A008C001_261013LI.MP4)', at: '2026-10-14T05:00:00.000Z', fileCount: 120, totalBytes: 5e11 }
const aged = (o: any = {}) => ({ bookingCode: 'WLT-MNW-261012-01', windowDate: new Date('2026-10-12'), fileCount: 120, totalBytes: 5e11, walkedAt: new Date('2026-10-15'), skippedByDesign: false, ...o })

test('aged out + held with the same footage → agedOutHeld, not "press 📣"', () => {
  const b = bucketPending([aged({ held: HELD })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOut, [])
  assert.deepEqual(b.agedOutHeld, [{ code: 'WLT-MNW-261012-01', detail: HELD.detail, at: HELD.at }])
  const a = footageReadyAlerts({ workerEnabled: true, audience: 'team', windowDays: 7, shootsOver: 19, checkDays: 30,
    sends: summarizeSends([{ bookingCode: 'A', at: new Date(), recipients: ['x@thestandard.co'] }]), pending: b })
  assert.ok(a.some(l => l.includes('อย่าเพิ่งกด 📣') && l.includes('A014C001_261013XU.MP4') && l.includes('ตรวจ 2026-10-14') && l.includes('run?codes=')), a.join('\n'))
  assert.ok(!a.some(l => l.includes('ต้องกด 📣 เอง')), 'must not tell anyone to press 📣 for incomplete footage')
})

// v1.290 — was "stale → back to press 📣": a hold whose footage changed is not evidence the box is complete
// (NWS-KYM-261026-01: held at 20 files, 1,019 after editors added exports, MEDIAPRO still missing)
test('held but the footage changed since → stays held, flagged stale (never "press 📣")', () => {
  const b = bucketPending([aged({ held: HELD, fileCount: 122 })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOut, [])
  assert.deepEqual(b.agedOutHeld, [{ code: 'WLT-MNW-261012-01', detail: HELD.detail, at: HELD.at, stale: true }])
})

test('held inside the window stays "waiting" — the sweep still owns it', () => {
  const b = bucketPending([aged({ held: HELD, windowDate: new Date('2026-10-26') })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.waiting, ['WLT-MNW-261012-01'])
  assert.deepEqual(b.agedOutHeld, [])
})

test('readHeld tolerates the settle snapshot with or without a hold', () => {
  assert.equal(readHeld(null), null)
  assert.equal(readHeld({ fileCount: 3, totalBytes: 9, at: '2026-10-14T00:00:00Z' }), null)
  assert.deepEqual(readHeld({ fileCount: 3, totalBytes: 9, at: 'x', held: HELD }), HELD)
  assert.equal(readHeld({ held: { detail: 'x' } }), null, 'half-written hold is ignored, not trusted')
})

test('held, same file count but bytes changed (a clip re-copied over a partial one) → stale, still held', () => {
  const b = bucketPending([aged({ held: HELD, totalBytes: 5e11 + 4e9 })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOut, [])
  assert.deepEqual(b.agedOutHeld, [{ code: 'WLT-MNW-261012-01', detail: HELD.detail, at: HELD.at, stale: true }])
})

test('a hold written without bytes (half-written) is not trusted', () => {
  assert.equal(readHeld({ held: { detail: 'x', at: 'y', fileCount: 1 } }), null)
})


// ── v1.290 — the report must not send anyone to 📣 on a guess ───────────────
const H = (o: any = {}) => ({ workerEnabled: true, audience: 'team', windowDays: 7, shootsOver: 3, checkDays: 30,
  sends: summarizeSends([{ bookingCode: 'A', at: new Date(), recipients: ['x@thestandard.co'] }]), ...o })

test('(a) stale hold: the line says re-check with a dry-run for THAT code, and still "do not press 📣"', () => {
  const kym = aged({ bookingCode: 'NWS-KYM-261026-01', windowDate: new Date('2026-10-26'), fileCount: 1019, totalBytes: 9e11,
    held: { ...HELD, fileCount: 20, totalBytes: 2e10 } })
  const b = bucketPending([kym], new Date('2026-11-20T03:00:00Z'), 4)
  assert.deepEqual(b.agedOut, [])
  assert.equal(b.agedOutHeld[0].stale, true)
  const a = footageReadyAlerts(H({ pending: b }))
  assert.equal(a.length, 1, a.join('\n'))
  assert.ok(a[0].includes('อย่าเพิ่งกด 📣'), a[0])
  assert.ok(a[0].includes('ไฟล์เปลี่ยนหลังตรวจ') && a[0].includes('run?dryRun=1&codes=NWS-KYM-261026-01'), a[0])
})

test('(a) a hold that still matches is not flagged stale and gets no dry-run hint', () => {
  const b = bucketPending([aged({ held: HELD })], new Date('2026-10-27'), 4)
  const a = footageReadyAlerts(H({ pending: b }))
  assert.ok(!a[0].includes('ไฟล์เปลี่ยนหลังตรวจ') && !a[0].includes('dryRun'), a[0])
})

test('(b) aged out, no hold: recommend run?codes= (every gate) — 📣 only after a dry-run says it would notify', () => {
  const b = bucketPending([aged()], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOut, ['WLT-MNW-261012-01'])
  const a = footageReadyAlerts(H({ pending: b }))
  assert.equal(a.length, 1)
  assert.ok(a[0].includes('footage-ready/run?codes=<code>') && a[0].includes('MEDIAPRO'), a[0])
  assert.ok(a[0].includes('run?dryRun=1&codes=<code> บอกว่าจะแจ้งก่อน'), a[0])
  assert.ok(!a[0].includes('ต้องกด 📣 เอง'), 'never a blind "press 📣"')
})

test('(b) aged out while the NAS still reports pending files → its own bucket, never "files on Drive"', () => {
  // POP-7TG-261116-01: folder vanished from the NAS with lastPending 5 — run?codes= stops at gate (d)
  const b = bucketPending([aged({ bookingCode: 'POP-7TG-261116-01', nasPending: 5 })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOut, [])
  assert.deepEqual(b.agedOutNas, [{ code: 'POP-7TG-261116-01', pending: 5 }])
  const a = footageReadyAlerts(H({ pending: b }))
  assert.equal(a.length, 1)
  assert.ok(a[0].includes('POP-7TG-261116-01 (ค้าง 5 ไฟล์)') && a[0].includes('ด่าน NAS') && a[0].includes('อย่ากด 📣'), a[0])
  assert.ok(a[0].includes('run?dryRun=1&codes=<code>'), a[0])
  assert.ok(!a[0].includes('มีฟุตเทจบน Drive แล้ว'), a[0])
})

test('(b) NAS gate comes before the MEDIAPRO hold — the order the sweep runs them', () => {
  const b = bucketPending([aged({ held: HELD, nasPending: 2 })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.agedOutNas, [{ code: 'WLT-MNW-261012-01', pending: 2 }])
  assert.deepEqual(b.agedOutHeld, [])
})

test('(b) inside the window the NAS gate is the sweep\'s business — still "waiting"', () => {
  const b = bucketPending([aged({ windowDate: new Date('2026-10-26'), nasPending: 9 })], new Date('2026-10-27'), 4)
  assert.deepEqual(b.waiting, ['WLT-MNW-261012-01'])
  assert.deepEqual(b.agedOutNas, [])
})

test('(b) NAS state unreadable → the agedOut line says it cannot tell which are stuck at the NAS gate', () => {
  const b = bucketPending([aged()], new Date('2026-10-27'), 4)
  const a = footageReadyAlerts(H({ pending: b, nasError: 'relation "nas_sync_state" does not exist' }))
  assert.ok(a[0].includes('อ่านสถานะ NAS ไม่ได้') && a[0].includes('nas_sync_state'), a[0])
  // r2 — the sweep reads a failed NAS read as gate (d) off: the real run is never the first thing offered
  const dry = a[0].indexOf('run?dryRun=1&codes=<code>')
  assert.ok(dry > 0 && a[0].includes('รอจนอ่านสถานะ NAS ได้'), a[0])
  const real = a[0].indexOf('run?codes=')
  assert.ok(real === -1 || real > dry, `dry-run must lead: ${a[0]}`)
  assert.ok(!a[0].includes('ตรวจ+ส่งด้วย'), 'no "check+send with the real run" while NAS is unreadable')
  assert.ok(a[0].indexOf('อ่านสถานะ NAS ไม่ได้') < dry, 'the reason comes before the instruction')
  // integration review — the held line has the same trap: its "files complete? run?codes=" hint must not offer the real run
  const hb = bucketPending([aged({ held: HELD })], new Date('2026-10-27'), 4)
  const held = footageReadyAlerts(H({ pending: hb, nasError: 'timeout' })).find(l => l.includes('ด่าน MEDIAPRO กันไว้'))!
  assert.ok(held && held.includes('run?dryRun=1&codes=<code>') && !held.includes('run?codes=<code> ตรวจซ้ำ (ครบ = ส่งเอง)'), held)
  const ok = footageReadyAlerts(H({ pending: hb })).find(l => l.includes('ด่าน MEDIAPRO กันไว้'))!
  assert.ok(ok.includes('run?codes=<code> ตรวจซ้ำ (ครบ = ส่งเอง)'), 'NAS readable: the real re-check stays as before')
})

test('(c) cutoff matches the worker: day D is swept through D+lookback, aged out at (D+lookback+1) 00:00Z', () => {
  const D = new Date('2026-11-16T00:00:00Z') // @db.Date as Prisma returns it
  assert.equal(new Date(sweptUntil(D, 4)).toISOString(), '2026-11-21T00:00:00.000Z')
  assert.equal(sweptUntil(new Date('2026-11-16T17:00:00Z'), 4), sweptUntil(D, 4), 'the date decides, not the time')
  const r = aged({ bookingCode: 'POP-7TG-261116-01', windowDate: D })
  // the old ms cutoff called this aged out right after 2026-11-20 00:00Z while the worker still swept it all day
  assert.deepEqual(bucketPending([r], new Date('2026-11-20T00:00:00Z'), 4).waiting, ['POP-7TG-261116-01'], 'D+lookback 00:00Z')
  assert.deepEqual(bucketPending([r], new Date('2026-11-20T23:59:59.999Z'), 4).waiting, ['POP-7TG-261116-01'], 'D+lookback last ms')
  assert.deepEqual(bucketPending([r], new Date('2026-11-21T00:00:00Z'), 4).agedOut, ['POP-7TG-261116-01'], 'D+lookback+1 00:00Z')
})

test('(d) aged-out rows past the daily check are counted in their line', () => {
  const now = new Date('2026-11-20T03:00:00Z')
  const b = bucketPending([
    aged({ bookingCode: 'OLD-1', windowDate: new Date('2026-10-12'), pastCheck: true }),
    aged({ bookingCode: 'NEW-1', windowDate: new Date('2026-11-10') }),
    aged({ bookingCode: 'OLD-H', windowDate: new Date('2026-10-12'), pastCheck: true, held: { ...HELD, fileCount: 1 } }),
  ], now, 4)
  assert.deepEqual(b.agedOut, ['OLD-1', 'NEW-1'])
  assert.deepEqual(b.pastCheck, ['OLD-1', 'OLD-H'])
  const a = footageReadyAlerts(H({ pending: b }))
  assert.ok(a[0].includes('ในนี้ 1 ใบถ่ายเกิน 30 วัน'), a[0])
  assert.ok(a[1].includes('OLD-H') && a[1].includes('ในนี้ 1 ใบถ่ายเกิน 30 วัน'), a[1])
  const fresh = footageReadyAlerts(H({ pending: bucketPending([aged({ bookingCode: 'NEW-1', windowDate: new Date('2026-11-10') })], now, 4) }))
  assert.ok(!fresh[0].includes('ถ่ายเกิน'), 'no note when none are old')
})

test('(c) neverWalked uses the same cutoff as the worker: un-walked on D+lookback 12:00Z = starved, gone at D+lookback+1', () => {
  const D = new Date('2026-11-16T00:00:00Z')
  const r: PendingBooking = { bookingCode: 'COLD-EDGE', windowDate: D, fileCount: 0, walkedAt: null }
  const noon = new Date('2026-11-20T12:00:00Z') // D+4, the worker still sweeps it all day (old ms cutoff: out at 00:00Z)
  assert.ok(noon.getTime() - D.getTime() >= COLD_AFTER_MS)
  assert.deepEqual(bucketPending([r], noon, 4).neverWalked, ['COLD-EDGE'])
  assert.deepEqual(bucketPending([r], new Date('2026-11-21T00:00:00Z'), 4).neverWalked, [], 'the worker has let go: nothing to walk')
})

// ── v1.290 r2 — 📣 preview must not hide a stale hold ─────────────────────────
test('previewHeld: no hold → null · same footage → the hold · footage changed → the hold flagged stale', () => {
  assert.equal(previewHeld(null, 120, 5e11), null)
  assert.equal(previewHeld({ fileCount: 1, totalBytes: 1, at: 'x' }, 120, 5e11), null, 'settle snapshot without a hold')
  assert.deepEqual(previewHeld({ held: HELD }, 120, 5e11), HELD)
  assert.deepEqual(previewHeld({ held: HELD }, 1019, 9e11), { ...HELD, stale: true }, 'NWS-KYM-261026-01 shape: must not vanish')
  assert.deepEqual(previewHeld({ held: HELD }, 120, 5e11 + 1), { ...HELD, stale: true })
})

test('heldConfirmWarning: stale → re-check with a dry-run for THAT code · held → the v1.274 text · none → empty', () => {
  const stale = heldConfirmWarning({ ...HELD, stale: true }, 'NWS-KYM-261026-01')
  assert.ok(stale.startsWith('⚠️ ไฟล์เปลี่ยนหลังตรวจ (เดิมถูกถือเพราะ ขาด 2 ไฟล์ตาม MEDIAPRO'), stale)
  assert.ok(stale.includes('ตรวจซ้ำด้วย footage-ready/run?dryRun=1&codes=NWS-KYM-261026-01 ก่อนกด'), stale)
  assert.ok(stale.endsWith('\n\n'))
  assert.equal(heldConfirmWarning(HELD, 'X'),
    `⚠️ ระบบอัตโนมัติยังไม่แจ้ง เพราะไฟล์ไม่ครบ (ตรวจ 2026-10-14): ${HELD.detail}\nส่งตอนนี้ = ทีมจะได้แจ้งว่าพร้อมทั้งที่ยังขาดไฟล์\n\n`)
  assert.equal(heldConfirmWarning(null, 'X'), '')
  assert.equal(heldConfirmWarning(undefined), '')
  assert.ok(heldConfirmWarning({ ...HELD, stale: true }).includes('codes=<code>'), 'no code → a placeholder, never "undefined"')
})
