import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIX_STATUSES, isMixStatus, formatMixNumber, canTransition,
  canEditMixJob, canClaimMixJob, canAssignMixJob, canSetMixStatus, isAssignableTo,
  canCloseMixJob, normalizeHttpLink,
  mixFlag, deliveredOnTime, validateMixJob, compareMixQueue,
  normalizeMixQuery, resolveMixTarget, canSetDeliveryLink, episodeBelongsToBooking, findDuplicateMixJobs,
  mixLoadLevel, buildMixCalendar, bangkokDateKey, addDaysKey, MIX_STATUS_LABEL,
  type MixActor, type MixTargetBooking,
} from '../mix-jobs'

// v1.215 — กฎของคิวมิกซ์ · ไฟล์นี้คือที่เดียวที่ตอบว่า "ใครทำอะไรได้"
// บั๊กสิทธิ์คือบั๊กที่มองไม่เห็นจากตาแอดมิน (v1.196: โปรดิวเซอร์มองไม่เห็นงาน
// ตัวเอง 59 ใบ) เทสจึงเขียนจากมุมของแต่ละคน ไม่ใช่มุมของคนที่เห็นทุกอย่าง

const requester: MixActor = { email: 'pd@thestandard.co', isSound: false, isCoordinator: false, canEditAll: false }
const engineer: MixActor = { email: 'sound@thestandard.co', isSound: true, isCoordinator: false, canEditAll: false }
const other: MixActor = { email: 'someone@thestandard.co', isSound: false, isCoordinator: false, canEditAll: false }
const admin: MixActor = { email: 'admin@thestandard.co', isSound: false, isCoordinator: false, canEditAll: true }
/** v1.216 — krittapon.j@ ตัวจริงบน prod: อยู่ในทีมเสียงและเป็นคนแจกงาน */
const coordinator: MixActor = { email: 'krittapon.j@thestandard.co', isSound: true, isCoordinator: true, canEditAll: false }

const queued = { status: 'QUEUED', requesterEmail: 'pd@thestandard.co', assigneeEmail: null }
const claimed = { status: 'IN_PROGRESS', requesterEmail: 'pd@thestandard.co', assigneeEmail: 'sound@thestandard.co' }

/* ─────────────────────────────── พื้นฐาน ─────────────────────────────── */

test('เลขที่อ่านออกและไม่ตัดทิ้งเมื่อเกินสามหลัก', () => {
  assert.equal(formatMixNumber(7), 'MIX-007')
  assert.equal(formatMixNumber(142), 'MIX-142')
  assert.equal(formatMixNumber(1234), 'MIX-1234')
})

test('isMixStatus ปฏิเสธค่าที่ไม่รู้จัก', () => {
  for (const s of MIX_STATUSES) assert.equal(isMixStatus(s), true)
  for (const s of ['done', 'PENDING', '', null, 5]) assert.equal(isMixStatus(s), false)
})

/* ────────────────────────── การเปลี่ยนสถานะ ─────────────────────────── */

test('เส้นทางสถานะที่อนุญาต — งานส่งแล้วกลับมาแก้ได้ เพราะลูกค้าขอแก้เป็นเรื่องปกติ', () => {
  assert.equal(canTransition('QUEUED', 'IN_PROGRESS'), true)
  assert.equal(canTransition('IN_PROGRESS', 'DONE'), true)
  assert.equal(canTransition('DONE', 'IN_PROGRESS'), true, 'ส่งแล้วขอแก้ต้องกลับมาทำได้')
  assert.equal(canTransition('CANCELLED', 'QUEUED'), true, 'ยกเลิกผิดต้องกู้กลับได้')
})

test('ข้ามขั้นไม่ได้ — QUEUED ไป DONE ตรง ๆ ไม่ได้ ไม่งั้นไม่มีใครรู้ว่าใครทำ', () => {
  assert.equal(canTransition('QUEUED', 'DONE'), false)
  assert.equal(canTransition('DONE', 'CANCELLED'), false)
  assert.equal(canTransition('DONE', 'QUEUED'), false)
})

test('สถานะเดิมไปสถานะเดิมได้เสมอ (บันทึกซ้ำไม่ควรพัง) และค่าประหลาดถูกปฏิเสธ', () => {
  assert.equal(canTransition('QUEUED', 'QUEUED'), true)
  assert.equal(canTransition('ประหลาด', 'DONE'), false)
  assert.equal(canTransition(null, 'IN_PROGRESS'), true, 'null = QUEUED ตามค่าเริ่มต้น')
})

/* ──────────────────────────────── สิทธิ์ ────────────────────────────── */

test('คนขอแก้ของตัวเองได้เฉพาะตอนยังไม่มีใครรับ', () => {
  assert.equal(canEditMixJob(requester, queued), true)
  assert.equal(canEditMixJob(requester, claimed), false,
    'พอทีมเสียงเริ่มทำแล้ว การแก้โจทย์กลางคันคือเปลี่ยนงานที่คนอื่นลงแรงไปแล้ว')
})

test('คนที่รับงานแก้ได้ตลอด · คนนอกแก้ไม่ได้เลย · แอดมินแก้ได้ทุกแถว', () => {
  assert.equal(canEditMixJob(engineer, claimed), true)
  assert.equal(canEditMixJob(other, queued), false)
  assert.equal(canEditMixJob(other, claimed), false)
  assert.equal(canEditMixJob(admin, claimed), true)
})

test('รับงานได้เฉพาะทีมเสียง และเฉพาะแถวที่ยังไม่มีเจ้าของ', () => {
  assert.equal(canClaimMixJob(engineer, queued), true)
  assert.equal(canClaimMixJob(engineer, claimed), false, 'มีคนรับแล้ว')
  assert.equal(canClaimMixJob(requester, queued), false,
    'คนขอรับงานตัวเองไม่ได้ ไม่งั้นตัวเลขภาระงานของทีมเสียงเชื่อไม่ได้')
  assert.equal(canClaimMixJob(engineer, { status: 'CANCELLED', assigneeEmail: null }), false)
})

test('คนขอยกเลิกงานตัวเองได้ แต่ทำอย่างอื่นกับสถานะไม่ได้', () => {
  assert.equal(canSetMixStatus(requester, queued, 'CANCELLED'), true)
  assert.equal(canSetMixStatus(requester, queued, 'IN_PROGRESS'), false)
  assert.equal(canSetMixStatus(requester, claimed, 'CANCELLED'), false,
    'เริ่มทำไปแล้ว ยกเลิกเงียบ ๆ ไม่ได้ ต้องคุยกับคนที่รับงาน')
})

test('คนนอกเปลี่ยนสถานะไม่ได้แม้เส้นทางจะถูกต้อง', () => {
  assert.equal(canTransition('QUEUED', 'IN_PROGRESS'), true)
  assert.equal(canSetMixStatus(other, queued, 'IN_PROGRESS'), false)
})

test('สิทธิ์ไม่ช่วยให้ข้ามเส้นทางสถานะที่ผิดได้ — แม้แอดมิน', () => {
  assert.equal(canSetMixStatus(admin, queued, 'DONE'), false)
  assert.equal(canSetMixStatus(engineer, { status: 'DONE' }, 'CANCELLED'), false)
})

/* ─────────────────────────── ธงเตือน / ตรงเวลา ───────────────────────── */

const TODAY = new Date('2026-09-10T08:00:00Z')

test('ธงเตือนเรียงตามความแรง: เลยกำหนด > ใกล้กำหนด > ยังไม่มีคนรับ', () => {
  assert.equal(mixFlag({ status: 'QUEUED', dueDate: '2026-09-08', assigneeEmail: null }, TODAY), 'OVERDUE')
  assert.equal(mixFlag({ status: 'IN_PROGRESS', dueDate: '2026-09-11', assigneeEmail: 'x@y' }, TODAY), 'DUE_SOON')
  assert.equal(mixFlag({ status: 'QUEUED', dueDate: null, assigneeEmail: null }, TODAY), 'UNCLAIMED')
  assert.equal(mixFlag({ status: 'IN_PROGRESS', dueDate: '2026-12-31', assigneeEmail: 'x@y' }, TODAY), null)
})

test('วันครบกำหนดพอดียังไม่ถือว่าเลย — ส่งวันนั้นก็ทัน', () => {
  assert.equal(mixFlag({ status: 'QUEUED', dueDate: '2026-09-10', assigneeEmail: 'x@y' }, TODAY), 'DUE_SOON')
})

test('งานที่จบแล้วไม่มีธง — ธงมีไว้ให้คนมองหาสิ่งที่ต้องลงมือ', () => {
  assert.equal(mixFlag({ status: 'DONE', dueDate: '2026-01-01', assigneeEmail: null }, TODAY), null)
  assert.equal(mixFlag({ status: 'CANCELLED', dueDate: '2026-01-01', assigneeEmail: null }, TODAY), null)
})

test('ตรงเวลาไหม — ไม่มีข้อมูลคือ null ไม่ใช่ "ไม่ทัน"', () => {
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-09', dueDate: '2026-09-10' }), true)
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-10', dueDate: '2026-09-10' }), true)
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-12', dueDate: '2026-09-10' }), false)
  assert.equal(deliveredOnTime({ deliveredAt: null, dueDate: '2026-09-10' }), null)
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-09', dueDate: null }), null,
    'ไม่ได้ตั้งกำหนด = วัดไม่ได้ ไม่ใช่สอบตก')
})

/* ────────────────────────────── การตรวจข้อมูล ───────────────────────── */

test('ต้องมีชื่องาน', () => {
  const r = validateMixJob({ title: '   ', bookingId: 'b1' })
  assert.equal(r.ok, false)
  assert.match((r as any).error, /ชื่องาน/)
})

test('ต้องมีใบจอง หรือลิงก์ อย่างน้อยหนึ่ง — ไม่งั้นทีมเสียงหาไฟล์ไม่เจอ', () => {
  const none = validateMixJob({ title: 'พอดแคสต์ EP.1' })
  assert.equal(none.ok, false)
  assert.match((none as any).error, /ใบจอง|ลิงก์/)

  assert.equal(validateMixJob({ title: 'ต่อจากกอง', bookingId: 'bk_1' }).ok, true)
  assert.equal(validateMixJob({ title: 'งานเดี่ยว', sourceLink: 'https://drive.google.com/x' }).ok, true)
})

test('ลิงก์ต้องเป็น http/https — กัน javascript: และของแปลก', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ไม่ใช่ลิงก์']) {
    const r = validateMixJob({ title: 'x', sourceLink: bad })
    assert.equal(r.ok, false, `${bad} ต้องไม่ผ่าน`)
  }
})

test('กำหนดส่งต้องเป็นวันที่จริง — 2026-02-31 ไม่ใช่วันที่', () => {
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b', dueDate: '2026-02-31' }).ok, false)
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b', dueDate: '10/09/2026' }).ok, false)
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b', dueDate: '2026-09-10' }).ok, true)
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b', dueDate: '' }).ok, true, 'ว่าง = ไม่ตั้งกำหนด')
})

test('ค่าที่ผ่านแล้วถูกทำความสะอาด ไม่ใช่ส่งดิบ ๆ ลง DB', () => {
  const r = validateMixJob({ title: '  มิกซ์ EP.4  ', bookingId: ' bk_9 ', episodeRowId: ' ep_2 ', notes: '  ด่วน  ', sourceLink: '' })
  assert.equal(r.ok, true)
  assert.deepEqual((r as any).value, {
    title: 'มิกซ์ EP.4', bookingId: 'bk_9', episodeRowId: 'ep_2', dueDate: null, sourceLink: null, notes: 'ด่วน',
  })
})

/* ──────────────────────────────── การเรียงคิว ───────────────────────── */

test('คิวเรียง: งานที่ยังเดินอยู่ก่อน → ใกล้กำหนดก่อน → ไม่มีกำหนดไปท้าย → มาก่อนได้ก่อน', () => {
  const rows = [
    { number: 1, status: 'DONE', dueDate: '2026-09-01' },
    { number: 2, status: 'QUEUED', dueDate: null },
    { number: 3, status: 'IN_PROGRESS', dueDate: '2026-09-12' },
    { number: 4, status: 'QUEUED', dueDate: '2026-09-05' },
    { number: 5, status: 'QUEUED', dueDate: '2026-09-05' },
  ]
  const order = [...rows].sort(compareMixQueue).map(r => r.number)
  assert.deepEqual(order, [4, 5, 3, 2, 1])
})


/* ───────────────── v1.216 — coordinator เป็นคนแจกงาน ───────────────── */

const SOUND_ROSTER = [
  'daejarnat.d@thestandard.co',
  'krittapon.j@thestandard.co',
  'nuthkitta.c@thestandard.co',
  'thaphat.t@thestandard.co',
]

test('เฉพาะ coordinator (และแอดมิน) เท่านั้นที่แจกงานให้คนอื่นได้', () => {
  assert.equal(canAssignMixJob(coordinator, queued), true)
  assert.equal(canAssignMixJob(admin, queued), true)
  assert.equal(canAssignMixJob(engineer, queued), false,
    'วิศวกรเสียงธรรมดาหยิบงานเองได้ แต่สั่งให้คนอื่นทำไม่ได้ — คนละอำนาจ')
  assert.equal(canAssignMixJob(requester, queued), false)
  assert.equal(canAssignMixJob(other, queued), false)
})

test('แจกซ้ำได้ระหว่างงานเดินอยู่ (คนป่วย/งานด่วนแทรก) แต่งานที่จบแล้วแจกไม่ได้', () => {
  assert.equal(canAssignMixJob(coordinator, claimed), true, 'เปลี่ยนตัวคนทำกลางทางได้')
  assert.equal(canAssignMixJob(coordinator, { status: 'DONE', assigneeEmail: 'x@y' }), false)
  assert.equal(canAssignMixJob(coordinator, { status: 'CANCELLED' }), false)
})

test('แจกได้เฉพาะคนที่อยู่ในทีมเสียงจริง — กันตัวเลขภาระงานเพี้ยน', () => {
  assert.equal(isAssignableTo('thaphat.t@thestandard.co', SOUND_ROSTER), true)
  assert.equal(isAssignableTo('  Krittapon.J@THESTANDARD.co ', SOUND_ROSTER), true,
    'ช่องว่างและตัวพิมพ์ใหญ่ต้องไม่ทำให้แจกไม่ได้')
  assert.equal(isAssignableTo('pd@thestandard.co', SOUND_ROSTER), false, 'คนนอกทีมเสียง')
  assert.equal(isAssignableTo('', SOUND_ROSTER), false)
})

test('การหยิบงานเองยังอยู่ — กันคิวค้างทั้งคิวตอน coordinator ลาหยุด', () => {
  assert.equal(canClaimMixJob(engineer, queued), true)
  assert.equal(canClaimMixJob(coordinator, queued), true)
})


/* ───────── v1.217 — ปิดงานไม่ได้ถ้ายังไม่บอกว่าไฟล์อยู่ไหน ───────── */

test('ลิงก์ที่ยอมรับ: http/https เท่านั้น — javascript:/file: ต้องตก', () => {
  assert.equal(normalizeHttpLink('https://drive.google.com/x'), 'https://drive.google.com/x')
  assert.equal(normalizeHttpLink('  http://a.co/b  '), 'http://a.co/b', 'ช่องว่างหัวท้ายต้องถูกตัด')
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'drive.google.com/x', '', null, 42]) {
    assert.equal(normalizeHttpLink(bad), null, `${String(bad)} ต้องไม่ผ่าน`)
  }
})

test('ปิดงานได้เมื่อมีลิงก์ — จากที่ส่งมาใหม่ หรือที่เคยแปะไว้แล้ว', () => {
  assert.equal(canCloseMixJob({}, 'https://drive.google.com/mixed'), true, 'ส่งลิงก์มาพร้อมกับการปิด')
  assert.equal(canCloseMixJob({ deliveryLink: 'https://drive.google.com/mixed' }), true,
    'แปะลิงก์ไว้ก่อนแล้วค่อยกดปิดทีหลังต้องได้ ไม่บังคับทำสองอย่างในคลิกเดียว')
})

test('ปิดงานไม่ได้เมื่อไม่มีลิงก์ หรือลิงก์ใช้ไม่ได้ — นี่คือจุดที่วงจรจะไม่ปิด', () => {
  assert.equal(canCloseMixJob({}), false)
  assert.equal(canCloseMixJob({ deliveryLink: null }, ''), false)
  assert.equal(canCloseMixJob({ deliveryLink: 'ไม่ใช่ลิงก์' }), false,
    'ค่าที่เคยเก็บไว้แต่ใช้ไม่ได้ ต้องไม่ถือว่าผ่าน')
  assert.equal(canCloseMixJob({}, 'javascript:alert(1)'), false)
})

/* ───────────────────── v1.244 ส่งงาน: เฉพาะคนที่ถูกแจก ───────────────────── */

test('v1.244 — ป้ายสถานะตามคำของ operator: Requested → Assigned → Completed', () => {
  assert.equal(MIX_STATUS_LABEL.QUEUED, 'Requested')
  assert.equal(MIX_STATUS_LABEL.IN_PROGRESS, 'Assigned')
  assert.equal(MIX_STATUS_LABEL.DONE, 'Completed')
})

test('v1.244 — ส่งงาน (DONE) ได้เฉพาะคนที่ถูกแจก · coordinator/แอดมินเป็นทางสำรอง · วิศวกรคนอื่นไม่ได้', () => {
  const mine = { ...claimed, assigneeEmail: 'sound@thestandard.co' }
  const notMine = { ...claimed, assigneeEmail: 'thaphat.t@thestandard.co' }
  assert.equal(canSetMixStatus(engineer, mine, 'DONE'), true, 'คนที่ถูกแจกส่งงานตัวเองได้')
  assert.equal(canSetMixStatus(engineer, notMine, 'DONE'), false,
    'วิศวกรเสียงคนอื่นปิดงานของเพื่อนไม่ได้ — ไม่งั้นเมลถึงคนขอบอกผิดว่าใครมิกซ์')
  assert.equal(canSetMixStatus(coordinator, notMine, 'DONE'), true)
  assert.equal(canSetMixStatus(admin, notMine, 'DONE'), true)
  assert.equal(canSetMixStatus(requester, notMine, 'DONE'), false)
  // สิทธิ์อื่นของทีมเสียงยังเหมือนเดิม
  assert.equal(canSetMixStatus(engineer, notMine, 'QUEUED'), true)
})

/* ─────────────────────── v1.244 จับคู่ EP ID / Booking ID ─────────────────────── */

test('normalizeMixQuery: full-width / ขีดยาว / ช่องว่าง / ตัวเล็ก → รหัสเดียวกัน', () => {
  assert.equal(normalizeMixQuery(' nws-tsn-260702-01 '), 'NWS-TSN-260702-01')
  assert.equal(normalizeMixQuery('ＮＷＳ－ＴＳＮ－２６０７０２－０１'), 'NWS-TSN-260702-01')
  assert.equal(normalizeMixQuery('PP–26—034_L01'), 'PP-26-034-L01')
  assert.equal(normalizeMixQuery('PP 26 034'), 'PP-26-034', 'ช่องว่างกลางรหัส = ขีด (รหัสจริงไม่มีช่องว่าง)')
  assert.equal(normalizeMixQuery('pp–26–099 l01'), 'PP-26-099-L01', 'เคสที่เจอตอนทดสอบบนเบราว์เซอร์')
  assert.equal(normalizeMixQuery('PP-26-034 - L01'), 'PP-26-034-L01', 'ขีดกับช่องว่างปนกันยุบเป็นขีดเดียว')
  assert.equal(normalizeMixQuery(' -NWS-TSN-260702-01- '), 'NWS-TSN-260702-01')
  assert.equal(normalizeMixQuery(null), '')
})

const NOW = new Date('2026-09-28T05:00:00Z')
const bk = (over: Partial<MixTargetBooking> & { id: string }): MixTargetBooking => ({
  bookingCode: null, status: 'CONFIRMED', shootDate: '2026-09-28', episodes: [], ...over,
})
// เคสจริงจาก prod: รหัสใบจอง = EP ID ของตอนที่ 1 ในใบเดียวกัน
const single = bk({ id: 'b1', bookingCode: 'NWS-TSN-260702-01', episodes: [{ id: 'e1', episodeId: 'NWS-TSN-260702-01', title: 'NOW' }] })
const multi = bk({ id: 'b2', bookingCode: 'WLT-MNW-261013-01', episodes: [
  { id: 'e21', episodeId: 'WLT-MNW-261013-01' }, { id: 'e22', episodeId: 'WLT-ITV-261013-01' }, { id: 'e23', episodeId: 'WLT-OTH-261013-01' },
] })
// EP ID เดียวถ่ายหลายวัน (PP-26-034-L01 อยู่ 10 ใบบน prod)
const agnA = bk({ id: 'a1', bookingCode: 'AGN-260911-02', shootDate: '2026-09-11', producerEmail: 'nice@thestandard.co', episodes: [{ id: 'x1', episodeId: 'PP-26-034-L01' }] })
const agnB = bk({ id: 'a2', bookingCode: 'AGN-260929-01', shootDate: '2026-09-29', producerEmail: 'other@thestandard.co', episodes: [{ id: 'x2', episodeId: 'PP-26-034-L01' }] })
const agnC = bk({ id: 'a3', bookingCode: 'AGN-261003-01', shootDate: '2026-10-03', producerEmail: 'other@thestandard.co', episodes: [{ id: 'x3', episodeId: 'PP-26-034-L01' }] })

test('รหัสใบจองที่มีตอนเดียว → ผูกตอนนั้นให้เลย ไม่ต้องถาม', () => {
  const r = resolveMixTarget('nws-tsn-260702-01', [single], 'me@x', NOW)
  assert.deepEqual(r, { kind: 'match', via: 'bookingCode', pick: { bookingId: 'b1', episodeRowId: 'e1' }, needsEpisodePick: false })
})

test('รหัสใบจองที่มีหลายตอน → ผูกทั้งใบ แล้วให้เลือกตอนต่อ (ไม่ผูกตอนที่ 1 ให้เงียบ ๆ)', () => {
  const r = resolveMixTarget('WLT-MNW-261013-01', [multi], 'me@x', NOW)
  assert.equal(r.kind, 'match')
  if (r.kind !== 'match') return
  assert.equal(r.via, 'bookingCode')
  assert.deepEqual(r.pick, { bookingId: 'b2', episodeRowId: null })
  assert.equal(r.needsEpisodePick, true)
})

test('EP ID ของตอนที่ 2 → ใบนั้น + ตอนนั้นตรง ๆ', () => {
  const r = resolveMixTarget('wlt-itv-261013-01', [multi], 'me@x', NOW)
  assert.deepEqual(r, { kind: 'match', via: 'episodeId', pick: { bookingId: 'b2', episodeRowId: 'e22' }, needsEpisodePick: false })
})

test('ไอดีภายในของใบจองก็ใช้ได้ (ลิงก์ /dashboard/<id> ที่ส่งต่อกันในแชท)', () => {
  const r = resolveMixTarget('b2', [multi], 'me@x', NOW)
  assert.equal(r.kind, 'match')
  if (r.kind === 'match') assert.equal(r.via, 'bookingId')
})

test('EP ID ที่อยู่หลายใบ → ambiguous ห้ามเดา · ใบของคนขอขึ้นก่อน แล้วใบที่วันถ่ายใกล้วันนี้', () => {
  const r = resolveMixTarget('PP-26-034-L01', [agnC, agnA, agnB], 'nice@thestandard.co', NOW)
  assert.equal(r.kind, 'ambiguous')
  if (r.kind !== 'ambiguous') return
  assert.deepEqual(r.options.map(o => o.bookingId), ['a1', 'a2', 'a3'],
    'a1 เป็นของคนขอ → ก่อน · a2 (29 ก.ย.) ใกล้วันนี้กว่า a3 (3 ต.ค.)')
  const r2 = resolveMixTarget('PP-26-034-L01', [agnC, agnA, agnB], 'nobody@x', NOW)
  if (r2.kind === 'ambiguous') assert.deepEqual(r2.options.map(o => o.bookingId), ['a2', 'a3', 'a1'])
})

test('ใบที่ถูกยกเลิก/ลบไม่นับ · เจอแต่ใบยกเลิก = บอกเหตุผลตรง ๆ ไม่ใช่ "ไม่พบ"', () => {
  const cancelled = { ...single, status: 'CANCELLED' }
  const r = resolveMixTarget('NWS-TSN-260702-01', [cancelled], 'me@x', NOW)
  assert.equal(r.kind, 'none')
  if (r.kind === 'none') assert.match(r.reason, /ยกเลิก/)
  const deleted = { ...agnA, deletedAt: '2026-09-20' }
  const r2 = resolveMixTarget('PP-26-034-L01', [deleted, agnB], 'nice@thestandard.co', NOW)
  assert.deepEqual(r2, { kind: 'match', via: 'episodeId', pick: { bookingId: 'a2', episodeRowId: 'x2' }, needsEpisodePick: false },
    'เหลือใบเดียวที่ยังมีชีวิต = ไม่กำกวมแล้ว')
})

test('ไม่พบ / พิมพ์ว่าง → none พร้อมข้อความที่บอกว่าทำอะไรต่อ', () => {
  const r = resolveMixTarget('XYZ-000', [single], 'me@x', NOW)
  assert.equal(r.kind, 'none')
  assert.equal(resolveMixTarget('   ', [single], 'me@x', NOW).kind, 'none')
})

test('ตอนต้องอยู่ในใบจองที่เลือกจริง — กันผูกใบ A กับตอนของใบ B', () => {
  assert.equal(episodeBelongsToBooking({ bookingId: 'b2' }, 'b2'), true)
  assert.equal(episodeBelongsToBooking({ bookingId: 'b1' }, 'b2'), false)
  assert.equal(episodeBelongsToBooking(null, 'b2'), false)
})

test('ระบุตอนต้องมีใบจอง · คำขอใหม่ต้องมีวันที่ต้องการไฟล์ · ของเดิมตอนแก้ไม่บังคับย้อนหลัง', () => {
  assert.equal(validateMixJob({ title: 'x', episodeRowId: 'e1', sourceLink: 'https://a.b' }).ok, false)
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b1' }, { requireDueDate: true }).ok, false)
  const ok = validateMixJob({ title: 'x', bookingId: 'b1', episodeRowId: 'e1', dueDate: '2026-10-01' }, { requireDueDate: true })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.value.episodeRowId, 'e1')
  assert.equal(validateMixJob({ title: 'x', bookingId: 'b1' }).ok, true, 'แก้งานเก่าที่ไม่มีวันยังผ่าน')
})

test('คำขอซ้ำ: ใบเดียวกันและ (ตอนเดียวกัน หรือฝั่งใดขอทั้งใบ) ที่ยังเปิดอยู่', () => {
  const jobs = [
    { bookingId: 'b2', episodeRowId: 'e22', status: 'QUEUED' },
    { bookingId: 'b2', episodeRowId: null, status: 'IN_PROGRESS' },
    { bookingId: 'b2', episodeRowId: 'e23', status: 'DONE' },
    { bookingId: 'b2', episodeRowId: 'e21', status: 'CANCELLED' },
    { bookingId: 'b1', episodeRowId: 'e1', status: 'QUEUED' },
    { bookingId: 'b2', episodeRowId: 'e22', status: 'QUEUED', deletedAt: '2026-09-01' },
  ]
  assert.equal(findDuplicateMixJobs(jobs, { bookingId: 'b2', episodeRowId: 'e22' }).length, 2, 'ตอนเดียวกัน + คำขอทั้งใบ')
  assert.equal(findDuplicateMixJobs(jobs, { bookingId: 'b2', episodeRowId: 'e23' }).length, 1, 'DONE ไม่นับ เหลือคำขอทั้งใบ')
  assert.equal(findDuplicateMixJobs(jobs, { bookingId: 'b2', episodeRowId: null }).length, 2, 'ขอทั้งใบชนทุกตอนที่ยังเปิด')
  assert.equal(findDuplicateMixJobs(jobs, { bookingId: 'b9', episodeRowId: null }).length, 0)
})

/* ─────────────────────── v1.244 ปฏิทินภาระงาน ─────────────────────── */

test('ระดับความแน่นเทียบกับจำนวนวิศวกร (1 งาน/คน/วัน)', () => {
  assert.equal(mixLoadLevel(0, 4), 'free')
  assert.equal(mixLoadLevel(2, 4), 'light')
  assert.equal(mixLoadLevel(3, 4), 'busy')
  assert.equal(mixLoadLevel(4, 4), 'busy')
  assert.equal(mixLoadLevel(5, 4), 'heavy')
  assert.equal(mixLoadLevel(1, 0), 'busy', 'ไม่มีวิศวกร active = ความจุขั้นต่ำ 1 ไม่ใช่หารศูนย์')
})

test('ปฏิทินนับตามวันที่ต้องการไฟล์ · ยกเลิก/ลบไม่นับ · แยกเปิด/ส่งแล้ว/ยังไม่มีคนรับ/ต่อคน', () => {
  const jobs = [
    { dueDate: '2026-10-01', status: 'QUEUED', assigneeEmail: null },
    { dueDate: '2026-10-01', status: 'IN_PROGRESS', assigneeEmail: 'Note@X' },
    { dueDate: '2026-10-01', status: 'DONE', assigneeEmail: 'note@x' },
    { dueDate: '2026-10-01', status: 'CANCELLED', assigneeEmail: null },
    { dueDate: '2026-10-02', status: 'IN_PROGRESS', assigneeEmail: 'note@x', deletedAt: '2026-09-30' },
    { dueDate: '2026-11-20', status: 'QUEUED', assigneeEmail: null },
    { dueDate: null, status: 'QUEUED', assigneeEmail: null },
  ]
  const days = buildMixCalendar(jobs, '2026-09-30', '2026-10-02', 4)
  assert.deepEqual(days.map(d => d.date), ['2026-09-30', '2026-10-01', '2026-10-02'])
  const oct1 = days[1]
  assert.deepEqual({ total: oct1.total, open: oct1.open, done: oct1.done, unassigned: oct1.unassigned },
    { total: 3, open: 2, done: 1, unassigned: 1 })
  assert.deepEqual(oct1.byAssignee, { 'note@x': 1 }, 'อีเมลรวมตัวพิมพ์เล็ก/ใหญ่เป็นคนเดียว')
  assert.equal(oct1.level, 'busy')
  assert.equal(days[2].total, 0, 'ลบแล้วไม่นับ')
  assert.deepEqual(buildMixCalendar(jobs, '2026-10-05', '2026-10-01', 4), [], 'ช่วงกลับหัว = ว่าง ไม่ใช่พัง')
  assert.equal(buildMixCalendar([], '2026-01-01', '2026-12-31', 4).length, 93, 'เพดาน 93 วัน')
})

test('วันไทย: 23:30 น. ของวันที่ 30 (UTC 16:30) ยังเป็นวันที่ 30 · 07:30 น. วันที่ 1 (UTC 00:30) เป็นวันที่ 1', () => {
  assert.equal(bangkokDateKey(new Date('2026-09-30T16:29:00Z')), '2026-09-30')
  assert.equal(bangkokDateKey(new Date('2026-09-30T17:00:00Z')), '2026-10-01')
  assert.equal(addDaysKey('2026-09-30', 1), '2026-10-01')
  assert.equal(addDaysKey('2026-03-01', -1), '2026-02-28')
})

test('v1.244 — ลิงก์ส่งงาน: Sound Admin ส่งแทนได้จริง (route กับการ์ดใช้กฎเดียวกัน ไม่ใช่การ์ดโชว์ปุ่มแล้ว 403)', () => {
  const notMine = { ...claimed, assigneeEmail: 'thaphat.t@thestandard.co' }
  assert.equal(canSetDeliveryLink(coordinator, notMine, 'DONE'), true, 'coordinator ส่งงานแทน')
  assert.equal(canSetDeliveryLink(coordinator, notMine, undefined), false, 'แค่แปะลิงก์ไว้เฉย ๆ ไม่ใช่เรื่องของ coordinator')
  assert.equal(canSetDeliveryLink(engineer, { ...claimed, assigneeEmail: 'sound@thestandard.co' }), true, 'คนที่ถูกแจกแปะลิงก์ได้เสมอ')
  assert.equal(canSetDeliveryLink(engineer, notMine, 'DONE'), false, 'วิศวกรคนอื่นส่งงานของเพื่อนไม่ได้')
  assert.equal(canSetDeliveryLink(requester, notMine, 'DONE'), false)
})

test('v1.244 — ส่งตีหนึ่งของวันถัดไป (เวลาไทย) = ไม่ทัน แม้ตามนาฬิกา UTC ยังเป็นวันกำหนด', () => {
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-10T16:30:00Z', dueDate: '2026-09-10' }), true, '23:30 BKK วันกำหนด')
  assert.equal(deliveredOnTime({ deliveredAt: '2026-09-10T18:00:00Z', dueDate: '2026-09-10' }), false, '01:00 BKK วันถัดไป')
})
