/**
 * "คนของงานนี้จองห้องเองไปแล้ว" (v1.227)
 *
 * เจอตอนกำลังจะเปิด War Room ให้จองอัตโนมัติ (2026-09-18): War Room มี 5 ใบรอจอง
 * และ **2 ใบในนั้นโปรดิวเซอร์เจ้าของงานจองห้องด้วยมือไปแล้ว เวลาตรงกันเป๊ะ**
 * เพราะก่อนหน้านี้โปรบุ๊คไม่ได้จองให้ ถ้าเปิดห้องดิบ ๆ ผลคือ CONFLICT + ป้าย
 * "⚠ ห้องไม่ว่าง" บนงานที่ห้องถูกกันไว้ถูกต้องแล้ว — สัญญาณหลอกตั้งแต่วันแรก
 * ซึ่งสอนให้คนเลิกเชื่อป้ายทั้งระบบ
 *
 * เส้นที่ต้องไม่ข้าม: **รับเฉพาะที่ห้องถูกกันไว้ให้จริง** ครอบไม่หมดช่วง หรือคนละคนจอง
 * = ชนของจริง ต้องปล่อยให้เป็น CONFLICT ให้คนมาจัดการ ห้ามกลืนหาย
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findManualHold } from '../room-booking'

const OWNER = 'pidsinee.y@thestandard.co'
const row = (o: any = {}) => ({
  bookingNo: 'BK-9', live: true, roomId: 2, isProbook: false,
  startAt: '2026-09-22T01:00:00.000Z', endAt: '2026-09-22T04:00:00.000Z',  // 08:00–11:00 ไทย
  bookedBy: 'Ant', email: OWNER, ...o,
})
// งานถ่าย 08:00–11:00 ไทย
const T = { roomId: 2, startAt: '2026-09-22T01:00:00.000Z', endAt: '2026-09-22T04:00:00.000Z' }

test('เคสจริง WLT-NGI: โปรดิวเซอร์จองห้องเองไว้ เวลาตรงเป๊ะ → รับว่าห้องได้แล้ว', () => {
  const h = findManualHold([row()], T, [OWNER])!
  assert.equal(h.bookingNo, 'BK-9')
  assert.equal(h.bookedBy, 'Ant')
})

test('จองครอบกว้างกว่าเวลาถ่าย → ยังนับว่าห้องได้แล้ว', () => {
  const wide = row({ startAt: '2026-09-22T00:00:00.000Z', endAt: '2026-09-22T06:00:00.000Z' })
  assert.ok(findManualHold([wide], T, [OWNER]))
})

test('**ครอบไม่หมดช่วงถ่าย → ไม่รับ** — ห้องไม่ได้ถูกกันไว้จริง', () => {
  const short = row({ endAt: '2026-09-22T02:00:00.000Z' })   // เลิก 09:00 แต่ถ่ายถึง 11:00
  assert.equal(findManualHold([short], T, [OWNER]), null)
  const late = row({ startAt: '2026-09-22T02:00:00.000Z' })  // เริ่ม 09:00 แต่ถ่ายตั้งแต่ 08:00
  assert.equal(findManualHold([late], T, [OWNER]), null)
})

test('**คนอื่นจอง → ไม่รับ** นี่คือชนของจริง', () => {
  assert.equal(findManualHold([row({ email: 'napas.l@thestandard.co' })], T, [OWNER]), null)
})

test('ห้องอื่นไม่นับ', () => {
  assert.equal(findManualHold([row({ roomId: 15 })], T, [OWNER]), null)
})

test('รายการที่ยกเลิกแล้วไม่นับ', () => {
  assert.equal(findManualHold([row({ live: false })], T, [OWNER]), null)
})

test('ใบที่โปรบุ๊คจองเองไม่ใช่ "จองมือ" — ทางนั้นมี marker จัดการอยู่แล้ว', () => {
  assert.equal(findManualHold([row({ isProbook: true })], T, [OWNER]), null)
})

test('ไม่รู้อีเมลเจ้าของงาน → ไม่เดา ไม่รับ', () => {
  assert.equal(findManualHold([row()], T, [null, undefined, '']), null)
  assert.equal(findManualHold([row()], T, ['ไม่ใช่อีเมล']), null)
})

test('อีเมลตัวพิมพ์ใหญ่/มีช่องว่างก็ยังจับคู่ได้', () => {
  assert.ok(findManualHold([row({ email: '  Pidsinee.Y@TheStandard.co ' })], T, [OWNER]))
})

test('คนเปิดใบ (ไม่ใช่โปรดิวเซอร์) จองเองก็นับ', () => {
  const h = findManualHold([row({ email: 'aphisit.h@thestandard.co' })], T,
                           [OWNER, 'aphisit.h@thestandard.co'])
  assert.ok(h)
})

test('ข้อมูลเวลาพังไม่ทำให้ล่ม', () => {
  assert.equal(findManualHold([row({ startAt: null })], T, [OWNER]), null)
  assert.equal(findManualHold([row({ endAt: 'ไม่ใช่เวลา' })], T, [OWNER]), null)
  assert.equal(findManualHold([row()], { ...T, startAt: 'พัง' }, [OWNER]), null)
})
