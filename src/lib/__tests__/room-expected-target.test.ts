/**
 * "ไม่ควรมีห้อง" ≠ "บอกไม่ได้" (v1.222 review fix)
 *
 * ตัวคืนสภาพแปล `expectedTarget() === null` ว่า "ใบนี้ไม่ควรถือห้อง" แล้ว **สั่ง
 * ยกเลิกห้อง** ตอนที่ค่านั้นยังเป็น null ก้อนเดียวสำหรับ skip ทุกเหตุผล มันจึงเหมา
 * เอาใบที่ *ข้อมูลไม่พอ* (เวลาพัง / ยังไม่กรอกเวลา / แปลง locationId ไม่ได้) ไปปลด
 * ห้องทิ้งด้วย ทั้งที่กองมีอยู่จริงและกำลังจะถ่าย
 *
 * ไฟล์นี้ล็อกเส้นแบ่งไว้ที่ระดับ roomTargetForBooking ซึ่งเป็นที่มาของการตัดสิน:
 *   external / no-room-mapping = ไม่ควรมีห้องจริง ๆ  → ปลดได้
 *   no-location / no-times / bad-times = ข้อมูลไม่พอ → ห้ามแตะห้อง
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomTargetForBooking } from '../room-booking'

const day = { shootDate: '2026-09-21', shootEndDate: null as string | null }

/** เหตุผล skip ที่แปลว่า "ไม่ควรมีห้องในระบบกลาง" — ปลดห้องได้ถูกต้อง */
const RELEASABLE = new Set(['external', 'no-room-mapping'])

test('งานนอกตึก = ไม่ควรมีห้อง (ปลดได้)', () => {
  const r = roomTargetForBooking({ ...day, locationId: 'on-location', callTime: '09:00', estimatedWrap: '18:00' }) as any
  assert.ok(r.skip, 'ต้องเป็น skip')
  assert.ok(RELEASABLE.has(r.skip), `${r.skip} ต้องอยู่ในกลุ่มที่ปลดห้องได้`)
})

test('เวลาพัง (wrap == call) = บอกไม่ได้ ห้ามปลดห้อง', () => {
  const r = roomTargetForBooking({
    ...day, shootEndDate: '2026-09-21', locationId: 'tsd-studio-1',
    callTime: '09:00', estimatedWrap: '09:00',
  }) as any
  assert.equal(r.skip, 'bad-times')
  assert.ok(!RELEASABLE.has(r.skip), 'bad-times ต้องไม่ทำให้ห้องถูกปลด')
})

test('ยังไม่กรอกเวลาเรียกกอง = บอกไม่ได้ ห้ามปลดห้อง', () => {
  const r = roomTargetForBooking({ ...day, locationId: 'tsd-studio-1', callTime: null }) as any
  assert.equal(r.skip, 'no-times')
  assert.ok(!RELEASABLE.has(r.skip), 'no-times ต้องไม่ทำให้ห้องถูกปลด')
})

test('แปลง locationId ไม่ได้ (เป็น null) = บอกไม่ได้ ห้ามปลดห้อง', () => {
  // resolveLocationId คืน null ได้ทั้งตอน "ย้ายออกนอกตึกจริง" และตอน "ชื่อสถานที่
  // ที่พิมพ์มาแมปไม่ได้" — แยกจากกันไม่ออก จึงต้องไม่ถือเป็นคำสั่งให้ปลดห้อง
  const r = roomTargetForBooking({ ...day, locationId: null, callTime: '09:00', estimatedWrap: '18:00' }) as any
  assert.equal(r.skip, 'no-location')
  assert.ok(!RELEASABLE.has(r.skip), 'no-location ต้องไม่ทำให้ห้องถูกปลด')
})

test('ห้องในตึกที่ระบบกลางไม่มี = ไม่ควรมีห้อง (ปลดได้)', () => {
  // Lounge อยู่ในตึกแต่ไม่มีในระบบจองห้องของ IT — ยึดห้องให้ไม่ได้อยู่แล้ว
  const r = roomTargetForBooking({ ...day, locationId: 'tsd-lounge', callTime: '09:00', estimatedWrap: '18:00' }) as any
  if (r.skip) assert.ok(RELEASABLE.has(r.skip), `${r.skip} ควรอยู่ในกลุ่มที่ปลดได้`)
})

test('ข้อมูลครบ = ได้ช่วงเวลาจริง ไม่ใช่ skip', () => {
  const r = roomTargetForBooking({ ...day, locationId: 'tsd-studio-1', callTime: '09:00', estimatedWrap: '18:00' }) as any
  assert.ok(r.target, 'ต้องได้ target')
  assert.equal(r.target.roomId, 15)
})
