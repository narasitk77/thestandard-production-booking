import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mixCalendarTargetError, planMixCalendar, mixJobWantsEvent, buildMixCalendarEvent, mixEventId, type MixCalendarJob,
} from '../mix-calendar-event'

// v1.245 — งานมิกซ์ → ปฏิทินแยก · operator: "ไม่ปนกับ probook เดิม"

const SHOOT_CAL = '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com'

const base: MixCalendarJob = {
  id: 'mj1', number: 14, title: 'Demo Brand Series · EP.1', status: 'QUEUED', dueDate: '2026-10-02',
  requesterEmail: 'pd@thestandard.co', assigneeEmail: null, bookingCode: 'AGN-260929-02', episodeCode: 'PP-26-099-L01',
  sourceLink: 'https://drive.google.com/src', deliveryLink: null, notes: null, calendarEventId: null,
}

test('ปฏิทินเป้าหมาย: ไม่ตั้ง = ปิด (ไม่ใช่ error) · ชี้ไปปฏิทินคิวถ่าย = ปฏิเสธดัง ๆ · ปฏิทินอื่น = ใช้ได้', () => {
  assert.equal(mixCalendarTargetError('', [SHOOT_CAL]), 'off')
  assert.equal(mixCalendarTargetError(undefined, [SHOOT_CAL]), 'off')
  const err = mixCalendarTargetError(` ${SHOOT_CAL.toUpperCase()} `, [SHOOT_CAL])
  assert.ok(err && err !== 'off' && /คิวถ่าย/.test(err), 'ตัวพิมพ์/ช่องว่างต่างกันก็ต้องจับได้ว่าเป็นปฏิทินเดิม')
  assert.equal(mixCalendarTargetError('mixqueue123@group.calendar.google.com', [SHOOT_CAL]), null)
})

test('แผน: มี event แล้ว → update · ยังไม่มี → create · ยกเลิก/ลบ/ไม่มีวันที่ → ลบ event ถ้ามี', () => {
  assert.equal(planMixCalendar(base), 'create')
  assert.equal(planMixCalendar({ ...base, calendarEventId: 'ev1' }), 'update')
  assert.equal(planMixCalendar({ ...base, status: 'CANCELLED', calendarEventId: 'ev1' }), 'delete')
  assert.equal(planMixCalendar({ ...base, deletedAt: '2026-09-28', calendarEventId: 'ev1' }), 'delete')
  assert.equal(planMixCalendar({ ...base, dueDate: null, calendarEventId: 'ev1' }), 'delete')
  assert.equal(planMixCalendar({ ...base, status: 'CANCELLED' }), 'none')
  assert.equal(mixJobWantsEvent({ ...base, status: 'DONE' }), true, 'ส่งแล้วยังโชว์ในปฏิทิน (เป็นประวัติภาระงานของวันนั้น)')
})

test('event เป็นงานทั้งวันบนวันที่ต้องการไฟล์ · ไม่บล็อกเวลา · ไม่มี attendees (ไม่มีเมลหาใคร)', () => {
  const ev = buildMixCalendarEvent(base, 'https://probook.xtec9.xyz/')
  assert.deepEqual(ev.start, { date: '2026-10-02' })
  assert.deepEqual(ev.end, { date: '2026-10-03' }, 'end ของงานทั้งวันคือวันถัดไป (exclusive)')
  assert.equal(ev.transparency, 'transparent')
  assert.ok(!('attendees' in ev), 'ห้ามมี attendees — Google จะส่งคำเชิญหาคนจริง')
  assert.equal(ev.extendedProperties.private.probookMixId, 'mj1')
  assert.match(ev.description, /คิวมิกซ์: https:\/\/probook\.xtec9\.xyz\/mix/)
  assert.match(ev.description, /ตอน PP-26-099-L01/)
})

test('ชื่อ event บอกสถานะกับคนทำ: รอแจก → ชื่อเล่นคนทำ → ✅ เมื่อส่งแล้ว', () => {
  assert.equal(buildMixCalendarEvent(base).summary, '🎚 MIX-014 · Demo Brand Series · EP.1 · รอแจก')
  const assigned = { ...base, status: 'IN_PROGRESS', assigneeEmail: 'thaphat.t@thestandard.co' }
  assert.equal(buildMixCalendarEvent(assigned).summary, '🎚 MIX-014 · Demo Brand Series · EP.1 · thaphat.t')
  const done = { ...assigned, status: 'DONE', deliveryLink: 'https://drive.google.com/out' }
  const ev = buildMixCalendarEvent(done)
  assert.equal(ev.summary, '✅ MIX-014 · Demo Brand Series · EP.1 · thaphat.t')
  assert.match(ev.description, /ไฟล์ที่มิกซ์แล้ว: https:\/\/drive\.google\.com\/out/)
  assert.notEqual(buildMixCalendarEvent(base).colorId, ev.colorId, 'สีต่างกันตามสถานะ')
})

test('dueDate แบบ Date (@db.Date = เที่ยงคืน UTC) ไม่เลื่อนวัน', () => {
  const ev = buildMixCalendarEvent({ ...base, dueDate: new Date('2026-10-02T00:00:00Z') })
  assert.deepEqual(ev.start, { date: '2026-10-02' })
})

test('event id คำนวณจาก id งาน: เหมือนเดิมทุกครั้ง · คนละงานไม่ชน · อยู่ในชุดอักษรที่ Google รับ (base32hex)', () => {
  const a = mixEventId('cmul3jhdu0003vj7dkbto1syt')
  assert.equal(a, mixEventId('cmul3jhdu0003vj7dkbto1syt'), 'deterministic = insert ซ้ำชน 409 แทนที่จะได้ event ตัวที่สอง')
  assert.notEqual(a, mixEventId('cmul3jhdu0003vj7dkbto1syu'))
  assert.match(a, /^[a-v0-9]{5,1024}$/)
  assert.match(mixEventId('xyz-WXYZ_'), /^[a-v0-9]+$/, 'ตัวอักษร w-z/ตัวใหญ่/ขีด ใน id ต้นทางไม่หลุดเข้า event id')
})

test('patch พร้อม status confirmed — ดึง event ที่ถูกลบในแอปปฏิทิน (status=cancelled) กลับมาได้', () => {
  assert.equal(buildMixCalendarEvent(base).status, 'confirmed')
})
