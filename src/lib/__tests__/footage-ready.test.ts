/**
 * Footage-ready auto-notify (v1.147) — pure settle logic.
 * The Drive I/O + send paths are exercised via the dryRun endpoint; here we lock
 * down the settle predicate the notify/no-notify decision hinges on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cameraCoverage, cameraWaitUntil, evaluateSettle, footageReadyRecipients, isInternalEmail, orderForWalk, parseReadySnapshot, parseForcedCodes, FORCED_MAX } from '../footage-ready'

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
  assert.deepEqual(r, { people: [], digest: true, inactive: [] })
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

test('v1.264: Co-Producer ได้แจ้งด้วยทุก audience ที่ไม่ใช่ admin (TSS: phoemsiri.p@ เป็น Co-Producer 32/52 ใบ)', () => {
  const withCo = { ...BK, coProducerEmail: ' Phoemsiri.P@thestandard.co ' }
  assert.deepEqual(footageReadyRecipients('team', withCo, ADMIN).people, [
    'prae@thestandard.co', 'phoemsiri.p@thestandard.co', 'coordinator@thestandard.co', 'video@thestandard.co', 'sound@thestandard.co',
  ], 'team: Co-Producer ต่อจาก producer · freelancer ภายนอกถูกตัดเหมือนเดิม')
  assert.deepEqual(footageReadyRecipients('producer', withCo, ADMIN).people, ['prae@thestandard.co', 'phoemsiri.p@thestandard.co'])
  assert.deepEqual(footageReadyRecipients('admin', withCo, ADMIN).people, [])
  // Co-Producer = producer หรือเป็นคนสร้างใบเอง → ไม่ได้เมลซ้ำ
  assert.deepEqual(footageReadyRecipients('team', { ...withCo, createdByEmail: 'phoemsiri.p@thestandard.co' }, ADMIN).people.filter(e => e.startsWith('phoemsiri')), ['phoemsiri.p@thestandard.co'])
  // ไม่มี Co-Producer (null / em-dash) = เหมือนเดิม
  assert.deepEqual(footageReadyRecipients('team', { ...BK, coProducerEmail: '—' }, ADMIN).people, footageReadyRecipients('team', BK, ADMIN).people)
})

test('v1.267: ผู้กำกับ 1–3 ได้แจ้งใน team/everyone (AGN พลาด 12 ฉบับ) · audience producer ไม่รวมผู้กำกับ', () => {
  const b = { ...BK, directorEmail: 'Worased.P@thestandard.co', director2Email: 'tanapak.i@thestandard.co', director3Email: 'prae@thestandard.co' }
  const team = footageReadyRecipients('team', b, ADMIN).people
  assert.ok(team.includes('worased.p@thestandard.co') && team.includes('tanapak.i@thestandard.co'))
  assert.equal(team.filter(e => e === 'prae@thestandard.co').length, 1, 'ผู้กำกับที่เป็น producer ด้วย = เมลเดียว')
  assert.deepEqual(footageReadyRecipients('producer', b, ADMIN).people, ['prae@thestandard.co'])
  assert.ok(!footageReadyRecipients('team', b, ADMIN, ['tanapak.i@thestandard.co']).people.includes('tanapak.i@thestandard.co'), 'ผู้กำกับที่ออกแล้วถูกตัดเหมือนคนอื่น')
})

test('v1.264: คนที่ปิดบัญชีแล้วไม่ได้เมล และถูกคืนชื่อให้บันทึก (แก้ว ออก 28 ก.ย. → เมลเด้ง 9 ต.ค.)', () => {
  const b = { ...BK, coProducerEmail: 'phoemsiri.p@thestandard.co', createdByEmail: 'Phoemsiri.P@thestandard.co' }
  const r = footageReadyRecipients('team', b, ADMIN, ['PHOEMSIRI.P@thestandard.co '])
  assert.ok(!r.people.includes('phoemsiri.p@thestandard.co'), 'ไม่ส่งหาบัญชีที่ปิดแล้ว')
  assert.deepEqual(r.inactive, ['phoemsiri.p@thestandard.co'], 'คืนชื่อครั้งเดียว ให้ผู้เรียกบันทึก ไม่ตัดเงียบ')
  assert.deepEqual(r.people, ['prae@thestandard.co', 'video@thestandard.co', 'sound@thestandard.co'])
  // ไม่ส่งรายชื่อ inactive มา = พฤติกรรมเดิม
  assert.deepEqual(footageReadyRecipients('team', b, ADMIN).inactive, [])
  // ทุกคนในใบออกไปแล้ว → people ว่าง (ผู้เรียกไปทางเตือนแอดมิน)
  const all = footageReadyRecipients('producer', { producerEmail: 'gone@thestandard.co' }, ADMIN, ['gone@thestandard.co'])
  assert.deepEqual(all, { people: [], digest: true, inactive: ['gone@thestandard.co'] })
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

// ── parseForcedCodes (v1.182) ───────────────────────────────────────────────
// `?codes=` is the only way to reach a booking that aged out of the lookback
// window, so the parser sits between an operator and a mail blast. Every case
// below is a way the param can arrive malformed; all of them must NARROW.

test('normal case: trims, upper-cases, keeps order, drops duplicates', () => {
  assert.deepEqual(
    parseForcedCodes(' pod-8mh-260814-01 , AGN-260814-01,pod-8mh-260814-01'),
    ['POD-8MH-260814-01', 'AGN-260814-01'],
  )
})

test('empty / missing / garbage yields NO codes — never "all bookings"', () => {
  for (const raw of [null, undefined, '', '   ', ',,,', '%%%', 'a']) {
    assert.deepEqual(parseForcedCodes(raw), [], `raw=${JSON.stringify(raw)}`)
  }
})

test('entries that are not code-shaped are dropped, the good ones survive', () => {
  assert.deepEqual(
    parseForcedCodes("AGN-260814-01, DROP TABLE bookings, ../../etc, TSS-TSS-260813-01"),
    ['AGN-260814-01', 'TSS-TSS-260813-01'],
  )
})

test('a fat finger cannot exceed FORCED_MAX', () => {
  const many = Array.from({ length: FORCED_MAX + 20 }, (_, i) => `AGN-2608${String(i).padStart(2, '0')}-01`)
  assert.equal(parseForcedCodes(many.join(',')).length, FORCED_MAX)
})

// ── v1.267 — กล้องยังไม่มา / มีแต่เสียง ─────────────────────────────────────────
// เคสจริง: AGN-261007-01 · POD-OPR-261007-01 แจ้งตอนมีแต่ WAV · TSS-TSS-261009-01 แจ้งตอน CAM-C ยังไม่มีภาพ

const F = (path: string[], name: string) => ({ name, folderPath: path })

test('มีแต่ไฟล์เสียง = ยังไม่ครบ (เมื่อใบจองกล้อง/ช่างภาพ) · ใบเสียงล้วนไม่ถูกกัน', () => {
  const wav = [F(['EP01', 'AUDIO'], 'REC-001.WAV'), F(['EP01'], '_SHOOT.txt')]
  assert.match(cameraCoverage(wav, { cameraCount: 2 }).gap, /ยังไม่มีไฟล์ภาพ/)
  assert.match(cameraCoverage(wav, { cameraCount: null, crewRequired: ['Videographer', 'Sound'] }).gap, /ยังไม่มีไฟล์ภาพ/)
  assert.equal(cameraCoverage(wav, { cameraCount: 0, crewRequired: ['Sound'] }).gap, '', 'งานอัดเสียงล้วน — ไม่มีอะไรให้รอ')
})

test('กล้องที่จองมีไฟล์ภาพไม่ครบ = บอกว่ามีกี่ตัว · Sub proxy ไม่นับเป็นภาพ · ครบ = ผ่าน', () => {
  const ab = [F(['EP01', 'CAM-A', 'XDROOT', 'Clip'], 'A001C001_261009XF.MXF'), F(['EP01', 'CAM B', 'Clip'], 'B001C001_261009XF.MXF'),
    F(['EP01', 'CAM-C', 'XDROOT', 'Sub'], 'C039C001_261009AYS03.MP4')]   // CAM-C has only a proxy → not an original
  const short = cameraCoverage(ab, { cameraCount: 3 })
  assert.deepEqual(short.cams, ['CAM-A', 'CAM-B'])
  assert.match(short.gap, /มีไฟล์ภาพ 2\/3 กล้อง \(CAM-A, CAM-B\)/)
  const full = cameraCoverage([...ab, F(['EP01', 'CAM-C', 'XDROOT', 'Clip'], 'C039C002_261009AY.MXF')], { cameraCount: 3 })
  assert.equal(full.gap, '')
  assert.equal(cameraCoverage(ab, { cameraCount: 2 }).gap, '', 'ถ่ายเกินจำนวนที่จองก็ผ่าน')
})

test('ภาพที่ไม่อยู่ในโฟลเดอร์ CAM-x = นับกล้องไม่ได้ → ตัดสินแค่ "มีภาพไหม" (ไม่เดาว่าขาดกล้อง)', () => {
  const loose = [F(['EP01', 'A001', 'Clip'], 'A001C001_261009XF.MXF')]
  const r = cameraCoverage(loose, { cameraCount: 3 })
  assert.equal(r.uncounted, true)
  assert.equal(r.gap, '')
  assert.equal(cameraCoverage([F(['ALL', 'CAM A', 'XDROOT', 'Clip'], 'x.mov')], { cameraCount: 1 }).gap, '', '"CAM A" (เว้นวรรค) นับเป็นกล้อง')
})

test('review v1.267: ชื่อโฟลเดอร์ตามการ์ด/ซากซิงก์นับเป็นกล้อง · โดรน/แอ็กชันแคมไม่ทำให้นับไม่ได้ · สำเนาการ์ดไม่นับเป็นกล้องที่สอง', () => {
  const r = cameraCoverage([F(['KIS', 'CAM A-1', 'M4ROOT', 'CLIP'], 'C0001.MP4'), F(['CAM-C (1)', 'Clip'], 'C001C001_261009AY.MXF'),
    F(['DRONE'], 'DJI_0001.MP4'), F(['Action cam', 'DCIM'], 'GX010001.MP4')], { cameraCount: 3 })
  assert.deepEqual(r.cams, ['CAM-A', 'CAM-C'])
  assert.equal(r.uncounted, false, 'โดรน/แอ็กชันแคมเป็นกล้องเสริม ไม่ทำให้นับไม่ได้')
  assert.match(r.gap, /2\/3 กล้อง/)
  // camera A's clips dragged into CAM-B (an md5 copy) must not make CAM-B count
  const dragged = [F(['EP01', 'CAM-A', 'XDROOT', 'Clip'], 'A038C001_261009XF.MXF'), F(['EP01', 'CAM-B', 'Clip'], 'A038C001_261009XF.MXF')]
  assert.match(cameraCoverage(dragged, { cameraCount: 2 }, ['EP01/CAM-B']).gap, /1\/2 กล้อง \(CAM-A\)/)
})

test('review v1.267: รอกล้องได้ถึงก่อนหน้าต่างปิด (คิดจาก lookback + settle) — LOOKBACK=3 ค่าตั้งต้นก็ยังเหลือรอบส่ง', () => {
  const d = new Date('2026-10-09T00:00:00Z') // @db.Date
  const settle = 4 * 3_600_000
  // window: shootDate >= now − lookback → last sweep that still sees it is before d + lookback days
  for (const lookback of [3, 4]) {
    const until = cameraWaitUntil(d, lookback, settle)
    const windowEnd = d.getTime() + lookback * 86_400_000
    assert.ok(until < windowEnd - settle, `lookback=${lookback}: ยังมีเวลาส่งฉบับเตือนหลังรอครบ`)
    assert.ok(until > d.getTime() + 86_400_000 + 12 * 3_600_000, `lookback=${lookback}: รอนานพอให้กล้องที่อัปช้าตามมาได้`)
  }
})

test('v1.276 — an MCP actor as the booking creator never gets the footage-ready mail (identity, not a mailbox)', () => {
  const r = footageReadyRecipients('everyone', { ...BK, createdByEmail: 'mcp-request@probook' }, ADMIN)
  assert.ok(!r.people.includes('mcp-request@probook'), r.people.join(','))
})

