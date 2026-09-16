/**
 * "แก้ใบจอง → ห้องต้องตาม" (v1.222)
 *
 * บั๊กที่ล็อกออกไป: การ **แก้** ใบจองไม่เคยแตะห้องเลย — PATCH ของแอดมินและ
 * producer-edit เขียน callTime / estimatedWrap / shootEndDate / locationId ได้
 * แล้ว re-sync ปฏิทินกับ OT แต่ห้องในระบบกลางถูกปล่อยค้างที่ช่วงเวลาเดิมตลอดไป
 * ส่วนช่วงเวลาใหม่ไม่มีห้อง และ syncRoomBooking ก็ไม่จองใหม่เพราะเห็นว่ามี
 * roomBookingNo แล้ว (SKIPPED already-booked) — เงียบสนิททุกทางจนถึงวันถ่าย
 *
 * ตัวตัดสินว่า "ตารางเปลี่ยนไหม" ต้องอยู่ที่เดียว ไม่งั้นสองเส้นทางแก้ไขจะหลุด
 * จากกันแบบเดียวกับกฎสิทธิ์ที่เคยเขียนซ้ำ 3 ที่
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomScheduleChanges } from '../room-booking-sync'

const base = {
  shootDate: new Date('2026-09-20T00:00:00.000Z'),
  shootEndDate: null,
  callTime: '09:00',
  estimatedWrap: '18:00',
  locationId: 'tsd-studio-1',
}

test('ไม่มีอะไรเปลี่ยน → ไม่คืนห้อง (ห้ามยิงระบบเขาเปล่า ๆ ทุกครั้งที่มีคนกดบันทึก)', () => {
  assert.deepEqual(roomScheduleChanges(base, { ...base }), [])
})

test('แก้ฟิลด์ที่ไม่เกี่ยวกับห้อง → ไม่คืนห้อง', () => {
  // notes / producer / cameraCount ฯลฯ ไม่ได้อยู่ในชุดนี้เลย จึงไม่มีผล
  assert.deepEqual(roomScheduleChanges(base, { ...base } as any), [])
})

test('เลื่อนเวลาเรียกกอง → ต้องคืนห้องแล้วจองใหม่', () => {
  assert.deepEqual(roomScheduleChanges(base, { ...base, callTime: '13:00' }), ['callTime'])
})

test('เปลี่ยนเวลาเลิก → ต้องคืนห้องแล้วจองใหม่ (ช่วงที่ยึดไว้สั้น/ยาวกว่าเดิม)', () => {
  assert.deepEqual(roomScheduleChanges(base, { ...base, estimatedWrap: '22:00' }), ['estimatedWrap'])
})

test('ย้ายห้อง → ต้องคืนห้องเดิม', () => {
  assert.deepEqual(roomScheduleChanges(base, { ...base, locationId: 'tsd-studio-2' }), ['locationId'])
})

test('ย้ายไปนอกตึก (locationId เป็น null) → ต้องคืนห้อง ไม่ใช่ยึดค้างไว้', () => {
  assert.deepEqual(roomScheduleChanges(base, { ...base, locationId: null }), ['locationId'])
})

test('เพิ่ม/ลบวันจบของงานหลายวัน → ต้องคืนห้อง', () => {
  assert.deepEqual(
    roomScheduleChanges(base, { ...base, shootEndDate: new Date('2026-09-22T00:00:00.000Z') }),
    ['shootEndDate'],
  )
  assert.deepEqual(
    roomScheduleChanges({ ...base, shootEndDate: new Date('2026-09-22T00:00:00.000Z') }, base),
    ['shootEndDate'],
  )
})

test('เปลี่ยนหลายอย่างพร้อมกัน → รายงานครบทุกฟิลด์ (ข้อความ audit ต้องบอกความจริง)', () => {
  const after = { ...base, callTime: '06:00', estimatedWrap: '12:00', locationId: 'tsd-studio-2' }
  assert.deepEqual(roomScheduleChanges(base, after), ['callTime', 'estimatedWrap', 'locationId'])
})

test('Date กับสตริงวันเดียวกัน ต้องไม่นับว่าเปลี่ยน', () => {
  // ของที่ผ่าน JSON มาแล้วเทียบกับ Date ตรง ๆ ต้องไม่หลอกให้คืนห้องทิ้งเปล่า ๆ
  assert.deepEqual(
    roomScheduleChanges(base, { ...base, shootDate: '2026-09-20T00:00:00.000Z' }),
    [],
  )
  assert.deepEqual(
    roomScheduleChanges({ ...base, shootEndDate: '2026-09-22T00:00:00.000Z' },
                       { ...base, shootEndDate: new Date('2026-09-22T00:00:00.000Z') }),
    [],
  )
})

test('null กับ undefined กับ "" ถือว่าเท่ากัน — ฟอร์มส่งค่าว่างมาคนละแบบ', () => {
  assert.deepEqual(roomScheduleChanges({ ...base, estimatedWrap: null }, { ...base, estimatedWrap: undefined }), [])
  assert.deepEqual(roomScheduleChanges({ ...base, estimatedWrap: null }, { ...base, estimatedWrap: '' }), [])
  assert.deepEqual(roomScheduleChanges({ ...base, shootEndDate: null }, { ...base, shootEndDate: undefined }), [])
})

test('วันที่พังต้องไม่ถูกอ่านว่า "เท่าเดิม"', () => {
  // Invalid Date เทียบกับวันจริงต้องนับว่าต่าง ไม่ใช่กลืนหายไปเงียบ ๆ
  const changed = roomScheduleChanges(base, { ...base, shootDate: new Date('ไม่ใช่วันที่') })
  assert.deepEqual(changed, ['shootDate'])
})
