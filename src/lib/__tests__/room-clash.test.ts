/**
 * "ห้องไม่ว่างเพราะอะไร" — ตัวอธิบายการชน (v1.226)
 *
 * ระบบกลางตอบแค่ "ถูกจองในช่วงเวลาดังกล่าวแล้ว" ซึ่งทำอะไรต่อไม่ได้ · เคสจริง
 * 29 ก.ย. 2026: `TSS-GEB-260929-01` จอง Studio 1 ไม่ได้ เพราะมีคนจองห้องเดียวกัน
 * ช่วงเดียวกัน **ด้วยมือผ่านพอร์ทัล** ให้งานเดียวกันนั่นเอง — ห้องไม่ได้หายไปไหน
 * แต่ไม่มีใครรู้ และ CONFLICT ก็นอนอยู่ใน DB เงียบ ๆ
 *
 * กฎที่ล็อกไว้:
 * 1. ต้องแยกออกว่า "โปรบุ๊คจองเอง" กับ "คนจองมือ" — คนละวิธีแก้คนละเรื่อง
 * 2. **ห้ามส่งหัวข้อการจองของแผนกอื่นออกไป** (กฎเดียวกับ v1.223) ชื่อคน+เวลาพอแล้ว
 * 3. รายการที่ถูกยกเลิกแล้วต้องไม่นับว่าชน
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRoomClashes, bkkTime } from '../room-booking'

const row = (o: any = {}) => ({
  id: 1, bookingNo: 'BK-1', title: 'ประชุมลับ HR เรื่องเงินเดือน', live: true,
  roomId: 15, startAt: '2026-09-29T06:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z',
  isProbook: false, bookedBy: 'Ingtawan Suwansupa', department: 'People', ...o,
})

const TARGET = { roomId: 15, startAt: '2026-09-29T05:30:00.000Z', endAt: '2026-09-29T09:00:00.000Z' }

test('เวลาไทยอ่านออก — 06:00Z = 13:00 ไทย', () => {
  assert.equal(bkkTime('2026-09-29T06:00:00.000Z'), '13:00')
  assert.equal(bkkTime(null), '?')
})

test('เจอการจองที่ชนในห้องเดียวกัน', () => {
  const rows = [row()]
  const c = pickRoomClashes(rows, TARGET)
  assert.equal(c.length, 1)
  assert.equal(c[0].bookingNo, 'BK-1')
  assert.equal(c[0].isProbook, false)
  assert.equal(c[0].bookedBy, 'Ingtawan Suwansupa')
})

test('**ไม่ส่งหัวข้อการจองออกมาเลย** — กันหัวข้อประชุมแผนกอื่นหลุด', () => {
  const rows = [row()]
  const c = pickRoomClashes(rows, TARGET)
  const dumped = JSON.stringify(c)
  assert.ok(!dumped.includes('HR'), 'หัวข้อต้องไม่หลุด')
  assert.ok(!dumped.includes('เงินเดือน'), 'หัวข้อต้องไม่หลุด')
  assert.ok(!('title' in c[0]), 'ไม่ควรมีฟิลด์ title ติดออกมาด้วยซ้ำ')
})

test('ห้องอื่นไม่นับ', () => {
  const rows = [row({ roomId: 1 })]
  assert.equal(pickRoomClashes(rows, TARGET).length, 0)
})

test('เวลาไม่ทับไม่นับ (ชนขอบพอดีก็ไม่นับ)', () => {
  const rows = [row({ startAt: '2026-09-29T09:00:00.000Z', endAt: '2026-09-29T11:00:00.000Z' })]
  assert.equal(pickRoomClashes(rows, TARGET).length, 0)
})

test('รายการที่ยกเลิกแล้วไม่นับว่าชน', () => {
  const rows = [row({ live: false })]
  assert.equal(pickRoomClashes(rows, TARGET).length, 0)
})

test('แยก "โปรบุ๊คจองเอง" ออกจาก "คนจองมือ" ได้', () => {
  const rows = [row({ bookingNo: 'BK-A', isProbook: true }), row({ bookingNo: 'BK-B', isProbook: false })]
  const c = pickRoomClashes(rows, TARGET)
  assert.deepEqual(c.map((x: any) => [x.bookingNo, x.isProbook]), [['BK-A', true], ['BK-B', false]])
})

test('รายการที่ไม่มีเวลาไม่ทำให้พัง', () => {
  const rows = [row({ startAt: null }), row({ bookingNo: 'BK-2', endAt: null })]
  assert.equal(pickRoomClashes(rows, TARGET).length, 0)
})
