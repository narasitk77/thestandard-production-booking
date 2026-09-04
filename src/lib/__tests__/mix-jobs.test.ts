import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIX_STATUSES, isMixStatus, formatMixNumber, canTransition,
  canEditMixJob, canClaimMixJob, canSetMixStatus,
  mixFlag, deliveredOnTime, validateMixJob, compareMixQueue,
  type MixActor,
} from '../mix-jobs'

// v1.215 — กฎของคิวมิกซ์ · ไฟล์นี้คือที่เดียวที่ตอบว่า "ใครทำอะไรได้"
// บั๊กสิทธิ์คือบั๊กที่มองไม่เห็นจากตาแอดมิน (v1.196: โปรดิวเซอร์มองไม่เห็นงาน
// ตัวเอง 59 ใบ) เทสจึงเขียนจากมุมของแต่ละคน ไม่ใช่มุมของคนที่เห็นทุกอย่าง

const requester: MixActor = { email: 'pd@thestandard.co', isSound: false, canEditAll: false }
const engineer: MixActor = { email: 'sound@thestandard.co', isSound: true, canEditAll: false }
const other: MixActor = { email: 'someone@thestandard.co', isSound: false, canEditAll: false }
const admin: MixActor = { email: 'admin@thestandard.co', isSound: false, canEditAll: true }

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
  const r = validateMixJob({ title: '  มิกซ์ EP.4  ', bookingId: ' bk_9 ', notes: '  ด่วน  ', sourceLink: '' })
  assert.equal(r.ok, true)
  assert.deepEqual((r as any).value, {
    title: 'มิกซ์ EP.4', bookingId: 'bk_9', dueDate: null, sourceLink: null, notes: 'ด่วน',
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
