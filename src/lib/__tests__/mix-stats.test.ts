import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mixEventKind, mixEventData, mixStateOf, mixTimeline, mixJobHistory, buildMixStats, mixLoadBand, mixStatsRange,
  mixActiveInRange, median, bangkokDateTime, canViewMixStats, mixEventsCsvRowsSorted,
  MIX_JOBS_CSV_COLUMNS, MIX_PEOPLE_CSV_COLUMNS, MIX_EVENTS_CSV_COLUMNS, mixJobCsvRow, mixPersonCsvRow, mixEventCsvRows,
  type MixStatsJob, type MixEventLike, type MixState,
} from '../mix-stats'

// v1.249 — ประวัติงานมิกซ์ + ตัวเลขภาระ/ผลงานรายคน · operator: "เก็บ performance ทีมงานทุกคน · export CSV · ใคร load มาก น้อย"

const A = 'thaphat.t@thestandard.co'
const B = 'daejarnat.d@thestandard.co'
const C = 'nuthkitta.c@thestandard.co'
const PD = 'pd@thestandard.co'
const ROSTER = [{ email: A, name: 'Thee Thaphat' }, { email: B, name: 'Dae' }, { email: C, name: 'Note' }]

const st = (status: string, assigneeEmail: string | null = null, dueDate: string | null = '2026-10-05'): MixState => ({ status, assigneeEmail, dueDate })

/** เหตุการณ์ตามลำดับ เหมือนที่ route เขียน (สถานะก่อน/หลังคู่กัน) */
function ev(at: string, before: MixState | null, after: MixState, opts: { claimed?: boolean; deleted?: boolean } = {}): MixEventLike {
  const d = mixEventData(before, after, 'actor@thestandard.co', opts)
  return { at, ...d }
}

function job(over: Partial<MixStatsJob> & { events?: MixEventLike[] }): MixStatsJob {
  return {
    id: 'j1', number: 1, title: 'งานทดสอบ', status: 'QUEUED', requesterEmail: PD,
    createdAt: '2026-10-01T02:00:00Z', dueDate: '2026-10-05', ...over,
  }
}

test('ป้ายการเปลี่ยน: แจก = เปลี่ยนคน + เริ่มทำในครั้งเดียว → ASSIGNED · สถานะปลายทางสำคัญกว่า', () => {
  assert.equal(mixEventKind(st('QUEUED'), st('IN_PROGRESS', A)), 'ASSIGNED')
  assert.equal(mixEventKind(st('QUEUED'), st('IN_PROGRESS', A), { claimed: true }), 'CLAIMED')
  assert.equal(mixEventKind(st('IN_PROGRESS', A), st('IN_PROGRESS', B)), 'REASSIGNED')
  assert.equal(mixEventKind(st('IN_PROGRESS', A), st('DONE', A)), 'DELIVERED')
  assert.equal(mixEventKind(st('DONE', A), st('IN_PROGRESS', A)), 'REOPENED')
  assert.equal(mixEventKind(st('IN_PROGRESS', A), st('QUEUED', A)), 'REQUEUED')
  assert.equal(mixEventKind(st('QUEUED'), st('CANCELLED')), 'CANCELLED')
  assert.equal(mixEventKind(st('CANCELLED'), st('QUEUED')), 'RESTORED')
  assert.equal(mixEventKind(st('QUEUED'), st('IN_PROGRESS')), 'STARTED')
  assert.equal(mixEventKind(st('QUEUED'), st('QUEUED', null, '2026-10-09')), 'DUE_CHANGED')
  assert.equal(mixEventKind(st('QUEUED'), st('QUEUED')), 'EDITED')
  assert.equal(mixEventKind(st('QUEUED'), st('QUEUED'), { deleted: true }), 'DELETED')
  assert.equal(mixEventKind(st('IN_PROGRESS', 'Thaphat.T@thestandard.co'), st('IN_PROGRESS', A)), 'EDITED', 'ตัวพิมพ์ต่างกันไม่ใช่การเปลี่ยนคน')
})

test('แถวที่เขียนลง DB: คำขอใหม่ไม่มีสถานะก่อน · อีเมลเป็นตัวเล็ก · วันที่เป็นเที่ยงคืน UTC', () => {
  const d = mixEventData(null, st('QUEUED', null, '2026-10-05'), 'PD@TheStandard.co')
  assert.equal(d.kind, 'REQUESTED')
  assert.equal(d.actorEmail, PD)
  assert.equal(d.fromStatus, null)
  assert.equal(d.dueDate?.toISOString(), '2026-10-05T00:00:00.000Z')
  const r = mixEventData(st('QUEUED'), st('IN_PROGRESS', 'Thaphat.T@thestandard.co'), PD)
  assert.equal(r.assigneeEmail, A)
  assert.equal(r.fromStatus, 'QUEUED')
})

test('งานก่อน v1.249 ไม่มีประวัติ → สร้างช่วงต้นจากแถวงาน (ติดธง synthetic) ตามเวลาจริงในแถว', () => {
  const t = mixTimeline(job({
    status: 'DONE', assigneeEmail: A, claimedAt: '2026-10-01T05:00:00Z', deliveredAt: '2026-10-03T09:00:00Z',
  }))
  assert.deepEqual(t.map(e => e.kind), ['REQUESTED', 'ASSIGNED', 'DELIVERED'])
  assert.ok(t.every(e => e.synthetic))
  assert.equal(t[1].at.toISOString(), '2026-10-01T05:00:00.000Z')
  assert.equal(t[2].at.toISOString(), '2026-10-03T09:00:00.000Z')
  const q = mixTimeline(job({}))
  assert.deepEqual(q.map(e => e.kind), ['REQUESTED'], 'คิวที่ยังไม่แจก = มีแค่คำขอ')
})

test('ประวัติเริ่มกลางทาง: ช่วงต้นสร้างจาก "สถานะก่อน" ของแถวจริงแรก และเวลาไม่เลยแถวจริงแรก', () => {
  // งานเก่าส่งแล้ว (deliveredAt ถูกล้างตอนเปิดแก้) → ประวัติจริงแถวแรกคือ REOPENED
  const t = mixTimeline(job({
    status: 'IN_PROGRESS', assigneeEmail: A, claimedAt: '2026-10-01T05:00:00Z', deliveredAt: null,
    events: [ev('2026-10-04T03:00:00Z', st('DONE', A), st('IN_PROGRESS', A))],
  }))
  assert.deepEqual(t.map(e => `${e.kind}${e.synthetic ? '*' : ''}`), ['REQUESTED*', 'ASSIGNED*', 'DELIVERED*', 'REOPENED'])
  for (let i = 1; i < t.length; i++) assert.ok(t[i].at >= t[i - 1].at, 'เวลาเรียงไม่กลับหัว')
  const h = mixJobHistory(job({
    status: 'IN_PROGRESS', assigneeEmail: A, claimedAt: '2026-10-01T05:00:00Z',
    events: [ev('2026-10-04T03:00:00Z', st('DONE', A), st('IN_PROGRESS', A))],
  }))
  assert.equal(h.revisionCount, 1)
  assert.equal(h.deliveries.length, 1)
})

test('แจกใหม่ A→B: A จบด้วย "โอนต่อ" · งานส่งเป็นของ B · เวลาทำนับจากตอน B เริ่มถือ', () => {
  const h = mixJobHistory(job({
    status: 'DONE', assigneeEmail: B,
    events: [
      ev('2026-10-01T02:00:00Z', null, st('QUEUED')),
      ev('2026-10-01T04:00:00Z', st('QUEUED'), st('IN_PROGRESS', A)),
      ev('2026-10-02T04:00:00Z', st('IN_PROGRESS', A), st('IN_PROGRESS', B)),
      ev('2026-10-02T10:00:00Z', st('IN_PROGRESS', B), st('DONE', B)),
    ],
  }))
  assert.deepEqual(h.segments.map(s => [s.email, s.endKind]), [[A, 'REASSIGNED'], [B, 'DELIVERED']])
  assert.equal(h.reassignCount, 1)
  assert.equal(h.deliveries[0].email, B)
  assert.equal(h.deliveries[0].hoursHeld, 6)
  assert.equal(h.queueWaitHours, 2, 'รอแจก = ขอ → แจกครั้งแรก')
  assert.equal(h.firstAssignee, A)
})

test('เปิดแก้แล้วส่งใหม่: ทันกำหนดดูที่ส่งครั้งแรกเท่านั้น · รอบแก้ไม่นับเป็นงานใหม่', () => {
  const h = mixJobHistory(job({
    status: 'DONE', assigneeEmail: A,
    events: [
      ev('2026-10-01T02:00:00Z', null, st('QUEUED')),
      ev('2026-10-01T04:00:00Z', st('QUEUED'), st('IN_PROGRESS', A)),
      ev('2026-10-04T04:00:00Z', st('IN_PROGRESS', A), st('DONE', A)),
      ev('2026-10-06T04:00:00Z', st('DONE', A), st('IN_PROGRESS', A)),
      ev('2026-10-07T04:00:00Z', st('IN_PROGRESS', A), st('DONE', A)),
    ],
  }))
  assert.deepEqual(h.deliveries.map(d => [d.first, d.onTime]), [[true, true], [false, null]])
  assert.equal(h.revisionCount, 1)
  assert.deepEqual(h.segments.map(s => s.revision), [false, true])
  assert.equal(h.endedAt?.toISOString(), '2026-10-07T04:00:00.000Z')
})

test('ทันกำหนดตัดที่เที่ยงคืนเวลาไทย ไม่ใช่ UTC · และเทียบกับวันที่ต้องการไฟล์ ณ ตอนส่ง', () => {
  const run = (deliverAt: string, due = '2026-10-01') => mixJobHistory(job({
    status: 'DONE', assigneeEmail: A, dueDate: due,
    events: [
      ev('2026-09-30T02:00:00Z', null, st('QUEUED', null, due)),
      ev('2026-09-30T03:00:00Z', st('QUEUED', null, due), st('IN_PROGRESS', A, due)),
      ev(deliverAt, st('IN_PROGRESS', A, due), st('DONE', A, due)),
    ],
  })).deliveries[0].onTime
  assert.equal(run('2026-10-01T16:30:00Z'), true, '23:30 ไทยของวันที่ 1 = ทัน')
  assert.equal(run('2026-10-01T17:30:00Z'), false, '00:30 ไทยของวันที่ 2 = ไม่ทัน')
  const moved = mixJobHistory(job({
    status: 'DONE', assigneeEmail: A,
    events: [
      ev('2026-09-30T02:00:00Z', null, st('QUEUED', null, '2026-10-01')),
      ev('2026-09-30T03:00:00Z', st('QUEUED', null, '2026-10-01'), st('IN_PROGRESS', A, '2026-10-01')),
      ev('2026-09-30T05:00:00Z', st('IN_PROGRESS', A, '2026-10-01'), st('IN_PROGRESS', A, '2026-10-03')),
      ev('2026-10-02T05:00:00Z', st('IN_PROGRESS', A, '2026-10-03'), st('DONE', A, '2026-10-03')),
    ],
  }))
  assert.equal(moved.deliveries[0].onTime, true, 'เลื่อนวันแล้วส่งทันวันใหม่ = ทัน')
})

test('ตัวเลขรายคน: ทุกคนในทีมมีแถว (รวมคนที่ศูนย์) · ภาระแยกตามความใกล้กำหนด · ช่วงวันที่กรองผลงาน', () => {
  const today = '2026-10-10'
  const jobs: MixStatsJob[] = [
    // A ถือ 3 งาน: เลยกำหนด 1 · ใกล้กำหนด 1 · ไม่มีกำหนด 1
    job({ id: 'a1', number: 1, status: 'IN_PROGRESS', assigneeEmail: A, dueDate: '2026-10-08', events: [ev('2026-10-01T02:00:00Z', null, st('QUEUED', null, '2026-10-08')), ev('2026-10-01T03:00:00Z', st('QUEUED', null, '2026-10-08'), st('IN_PROGRESS', A, '2026-10-08'))] }),
    job({ id: 'a2', number: 2, status: 'IN_PROGRESS', assigneeEmail: A, dueDate: '2026-10-12', events: [ev('2026-10-02T02:00:00Z', null, st('QUEUED', null, '2026-10-12')), ev('2026-10-02T03:00:00Z', st('QUEUED', null, '2026-10-12'), st('IN_PROGRESS', A, '2026-10-12'))] }),
    job({ id: 'a3', number: 3, status: 'IN_PROGRESS', assigneeEmail: A, dueDate: null, events: [ev('2026-10-02T02:00:00Z', null, st('QUEUED', null, null)), ev('2026-10-02T03:00:00Z', st('QUEUED', null, null), st('IN_PROGRESS', A, null))] }),
    // B ส่งทัน 1 งานในช่วง + 1 งานนอกช่วง (กันยา)
    job({ id: 'b1', number: 4, status: 'DONE', assigneeEmail: B, events: [ev('2026-10-01T02:00:00Z', null, st('QUEUED')), ev('2026-10-01T04:00:00Z', st('QUEUED'), st('IN_PROGRESS', B)), ev('2026-10-03T04:00:00Z', st('IN_PROGRESS', B), st('DONE', B))] }),
    job({ id: 'b2', number: 5, status: 'DONE', assigneeEmail: B, createdAt: '2026-09-01T02:00:00Z', events: [ev('2026-09-01T02:00:00Z', null, st('QUEUED', null, '2026-09-05')), ev('2026-09-01T04:00:00Z', st('QUEUED', null, '2026-09-05'), st('IN_PROGRESS', B, '2026-09-05')), ev('2026-09-06T04:00:00Z', st('IN_PROGRESS', B, '2026-09-05'), st('DONE', B, '2026-09-05'))] }),
    // C ถืองานแล้วลบทิ้ง — ไม่เป็นภาระตอนนี้ แต่ผลงานที่เกิดแล้วยังนับ (ได้รับงาน 1 · ลบระหว่างถือ 1)
    job({ id: 'x1', number: 6, status: 'IN_PROGRESS', assigneeEmail: C, deletedAt: '2026-10-02T05:00:00Z', events: [ev('2026-10-02T02:00:00Z', null, st('QUEUED')), ev('2026-10-02T03:00:00Z', st('QUEUED'), st('IN_PROGRESS', C)), ev('2026-10-02T05:00:00Z', st('IN_PROGRESS', C), st('IN_PROGRESS', C), { deleted: true })] }),
    // รอแจก เลยกำหนด
    job({ id: 'q1', number: 7, status: 'QUEUED', dueDate: '2026-10-09', events: [ev('2026-10-05T02:00:00Z', null, st('QUEUED', null, '2026-10-09'))] }),
  ]
  const s = buildMixStats(jobs, ROSTER, { from: '2026-10-01', to: '2026-10-31' }, today)
  const by = Object.fromEntries(s.people.map(p => [p.email, p]))
  assert.deepEqual(s.people.map(p => p.email), [A, B, C], 'เรียงภาระมากไปน้อย · C ที่ศูนย์ก็มีแถว')
  assert.deepEqual([by[A].open, by[A].openOverdue, by[A].openDueSoon, by[A].openLater, by[A].openNoDue], [3, 1, 1, 0, 1])
  assert.equal(by[A].assigned, 3)
  assert.equal(by[B].delivered, 1, 'งานที่ส่งเดือนก่อนไม่นับ')
  assert.equal(by[B].onTime, 1)
  assert.equal(by[B].medianHoursHeld, 48)
  assert.equal(by[C].open, 0, 'คำขอที่ลบแล้วไม่เป็นภาระ')
  assert.equal(by[C].assigned, 1, 'ลบทีหลังไม่ลบผลงานที่เกิดไปแล้ว')
  assert.equal(by[C].deletedWhileHolding, 1)
  assert.equal(s.team.openInProgress, 3)
  assert.equal(s.team.openQueued, 1)
  assert.equal(s.team.openOverdue, 2, 'A เลยกำหนด 1 + รอแจกเลยกำหนด 1')
  assert.equal(s.team.requested, 6, 'ขอในเดือนตุลา · งานที่เคยแจกแล้วถูกลบยังนับ')
  assert.equal(s.team.meanOpenPerPerson, 1)
  assert.equal(by[A].load, 'high')
  assert.equal(by[C].load, 'idle')
  assert.equal(s.team.onTimeRate, 1)
})

test('คนที่ออกจากทีมแล้วแต่ยังมีงานในช่วง ยังขึ้นแถว (ติดป้ายไม่อยู่ในทีม) · ไม่มีงานเลย = ไม่ขึ้น', () => {
  const OLD = 'left@thestandard.co'
  const jobs = [job({ status: 'DONE', assigneeEmail: OLD, events: [ev('2026-10-01T02:00:00Z', null, st('QUEUED')), ev('2026-10-01T03:00:00Z', st('QUEUED'), st('IN_PROGRESS', OLD)), ev('2026-10-02T03:00:00Z', st('IN_PROGRESS', OLD), st('DONE', OLD))] })]
  const s = buildMixStats(jobs, ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  const old = s.people.find(p => p.email === OLD)!
  assert.equal(old.inRoster, false)
  assert.equal(old.delivered, 1)
  const none = buildMixStats(jobs, ROSTER, { from: '2026-11-01', to: '2026-11-30' }, '2026-11-10')
  assert.ok(!none.people.some(p => p.email === OLD))
})

test('ป้ายภาระ: ต้องห่างค่าเฉลี่ยทั้งสัดส่วนและอย่างน้อย 1 งาน (ทีมเล็ก งานน้อย ไม่ให้ป้ายแกว่ง)', () => {
  assert.equal(mixLoadBand(0, 2), 'idle')
  assert.equal(mixLoadBand(1, 0.5), 'normal', 'มี 1 งานตอนเฉลี่ย 0.5 ไม่ใช่ภาระสูง')
  assert.equal(mixLoadBand(3, 1), 'high')
  assert.equal(mixLoadBand(1, 3), 'low')
  assert.equal(mixLoadBand(2, 3), 'normal')
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
})

test('ช่วงวันที่: ไม่ส่ง = เดือนนี้ทั้งเดือน · ผิดรูป/กลับหัว/ปีสองหลัก/ยาวเกิน = error', () => {
  assert.deepEqual(mixStatsRange(null, null, '2026-09-29'), { from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(mixStatsRange(null, null, '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' })
  assert.deepEqual(mixStatsRange('2026-09-15', null, '2026-09-29'), { from: '2026-09-15', to: '2026-09-29' })
  assert.ok('error' in mixStatsRange('2026-10-02', '2026-10-01'))
  assert.ok('error' in mixStatsRange('2026-9-1', '2026-10-01'))
  assert.ok('error' in mixStatsRange('0069-10-01', '0069-10-31'))
  assert.ok('error' in mixStatsRange('2024-01-01', '2026-12-31'))
})

test('งานที่ "มีชีวิต" ในช่วง: ขอก่อนสิ้นช่วง และยังไม่จบก่อนต้นช่วง', () => {
  const h = mixJobHistory(job({
    status: 'DONE', assigneeEmail: A,
    events: [ev('2026-09-20T02:00:00Z', null, st('QUEUED')), ev('2026-09-21T02:00:00Z', st('QUEUED'), st('IN_PROGRESS', A)), ev('2026-10-02T02:00:00Z', st('IN_PROGRESS', A), st('DONE', A))],
  }))
  assert.equal(mixActiveInRange(h, { from: '2026-10-01', to: '2026-10-31' }), true, 'ขอเดือนก่อน ส่งเดือนนี้')
  assert.equal(mixActiveInRange(h, { from: '2026-10-03', to: '2026-10-31' }), false, 'จบก่อนต้นช่วง')
  assert.equal(mixActiveInRange(h, { from: '2026-09-01', to: '2026-09-19' }), false, 'ขอหลังสิ้นช่วง')
})

test('CSV: ทุกแถวมีจำนวนช่องเท่าหัวตาราง · เวลาเป็นเวลาไทย', () => {
  const s = buildMixStats([job({
    status: 'DONE', assigneeEmail: A, deliveryLink: 'https://drive.google.com/out',
    events: [ev('2026-10-01T02:00:00Z', null, st('QUEUED')), ev('2026-10-01T03:00:00Z', st('QUEUED'), st('IN_PROGRESS', A)), ev('2026-10-02T03:00:00Z', st('IN_PROGRESS', A), st('DONE', A))],
  })], ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  assert.equal(mixJobCsvRow(s.histories[0]).length, MIX_JOBS_CSV_COLUMNS.length)
  for (const p of s.people) assert.equal(mixPersonCsvRow(p).length, MIX_PEOPLE_CSV_COLUMNS.length)
  const evRows = mixEventCsvRows(s.histories[0], s.range)
  assert.equal(evRows.length, 3)
  for (const r of evRows) assert.equal(r.length, MIX_EVENTS_CSV_COLUMNS.length)
  assert.equal(bangkokDateTime(new Date('2026-10-01T17:30:00Z')), '2026-10-02 00:30')
  assert.equal(mixJobCsvRow(s.histories[0])[15], 'ทัน')
})

test('ใครดูตัวเลขผลงานรายคน/export ได้: Sound Admin หรือแอดมิน/ผู้จัดการเท่านั้น', () => {
  assert.equal(canViewMixStats({ isCoordinator: true, canEditAll: false }), true)
  assert.equal(canViewMixStats({ isCoordinator: false, canEditAll: true }), true)
  assert.equal(canViewMixStats({ isCoordinator: false, canEditAll: false }), false, 'วิศวกรเสียง/คนขอทั่วไปไม่เห็นตัวเลขของคนอื่น')
})

test('สถานะจากแถวงาน: อีเมลตัวเล็ก วันที่เป็นวันล้วน', () => {
  assert.deepEqual(mixStateOf({ status: 'IN_PROGRESS', assigneeEmail: ' Thaphat.T@thestandard.co ', dueDate: new Date('2026-10-05T00:00:00Z') }), st('IN_PROGRESS', A, '2026-10-05'))
})

test('แจก A→B→A งานเดียว: A ได้รับงาน 1 ไม่ใช่ 2 · B ได้รับ 1 และโอนต่อ 1 (ผู้ตรวจเจอ)', () => {
  const s = buildMixStats([job({
    status: 'DONE', assigneeEmail: A,
    events: [
      ev('2026-10-01T02:00:00Z', null, st('QUEUED')),
      ev('2026-10-01T03:00:00Z', st('QUEUED'), st('IN_PROGRESS', A)),
      ev('2026-10-01T04:00:00Z', st('IN_PROGRESS', A), st('IN_PROGRESS', B)),
      ev('2026-10-01T05:00:00Z', st('IN_PROGRESS', B), st('IN_PROGRESS', A)),
      ev('2026-10-02T05:00:00Z', st('IN_PROGRESS', A), st('DONE', A)),
    ],
  })], ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  const by = Object.fromEntries(s.people.map(p => [p.email, p]))
  assert.deepEqual([by[A].assigned, by[A].handedOff, by[A].delivered], [1, 1, 1])
  assert.deepEqual([by[B].assigned, by[B].handedOff], [1, 1])
  assert.equal(by[A].medianHoursHeld, 24, 'เวลาทำของ A นับจากรอบที่ส่งจริง')
})

test('งานเก่าที่ส่งแล้วถูกเปิดแก้หลัง v1.249: ไม่เดาเวลาส่งเดิม — ไม่ตัดสินทัน/ไม่ทัน ไม่นับเข้าเดือนไหน แต่รอบถัดไปยังเป็นส่งแก้', () => {
  const legacy = job({
    status: 'DONE', assigneeEmail: A, dueDate: '2026-09-25', claimedAt: '2026-09-16T03:00:00Z', createdAt: '2026-09-15T03:00:00Z',
    deliveredAt: '2026-10-06T03:00:00Z', // ค่าใหม่จากรอบแก้ — ของเดิม (20 ก.ย.) ถูกล้างไปแล้ว
    events: [
      ev('2026-10-05T03:00:00Z', st('DONE', A, '2026-09-25'), st('IN_PROGRESS', A, '2026-09-25')),
      ev('2026-10-06T03:00:00Z', st('IN_PROGRESS', A, '2026-09-25'), st('DONE', A, '2026-09-25')),
    ],
  })
  const h = mixJobHistory(legacy)
  assert.deepEqual(h.deliveries.map(d => [d.first, d.timeKnown, d.onTime, d.hoursHeld]), [[true, false, null, null], [false, true, null, 24]])
  const oct = buildMixStats([legacy], ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  const a = oct.people.find(p => p.email === A)!
  assert.deepEqual([a.delivered, a.late, a.redelivered], [0, 0, 1], 'ไม่มี "ส่งไม่ทัน" ที่แต่งขึ้น')
  assert.equal(oct.team.late, 0)
  assert.equal(mixJobCsvRow(h)[13], 'ไม่ทราบ (ก่อนเริ่มเก็บประวัติ)')
})

test('ลบคำขอ: ถอนก่อนเคยแจก = ไม่นับเป็นคำขอเข้า · ส่งไม่ทันแล้วลบ = ยังนับว่าไม่ทัน', () => {
  const withdrawn = job({ id: 'w', deletedAt: '2026-10-01T05:00:00Z', events: [
    ev('2026-10-01T02:00:00Z', null, st('QUEUED')),
    ev('2026-10-01T05:00:00Z', st('QUEUED'), st('QUEUED'), { deleted: true }),
  ] })
  const lateThenDeleted = job({ id: 'l', status: 'DONE', assigneeEmail: A, dueDate: '2026-10-02', deletedAt: '2026-10-06T05:00:00Z', events: [
    ev('2026-10-01T02:00:00Z', null, st('QUEUED', null, '2026-10-02')),
    ev('2026-10-01T03:00:00Z', st('QUEUED', null, '2026-10-02'), st('IN_PROGRESS', A, '2026-10-02')),
    ev('2026-10-05T03:00:00Z', st('IN_PROGRESS', A, '2026-10-02'), st('DONE', A, '2026-10-02')),
    ev('2026-10-06T05:00:00Z', st('DONE', A, '2026-10-02'), st('DONE', A, '2026-10-02'), { deleted: true }),
  ] })
  const s = buildMixStats([withdrawn, lateThenDeleted], ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  assert.equal(s.team.requested, 1)
  const a = s.people.find(p => p.email === A)!
  assert.deepEqual([a.delivered, a.late, a.open], [1, 1, 0])
})

test('CSV ประวัติเรียงตามเวลาจริงข้ามงาน', () => {
  const j1 = job({ id: 'j1', number: 1, events: [ev('2026-10-03T02:00:00Z', null, st('QUEUED'))] })
  const j2 = job({ id: 'j2', number: 2, events: [ev('2026-10-01T02:00:00Z', null, st('QUEUED'))] })
  const s = buildMixStats([j1, j2], ROSTER, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-10')
  assert.deepEqual(mixEventsCsvRowsSorted(s.histories, s.range).map(r => r[1]), ['MIX-002', 'MIX-001'])
})
