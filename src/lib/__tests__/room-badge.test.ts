/**
 * กฎ "ใบจองนี้ควรขึ้นป้ายเรื่องห้องว่าอะไร" (v1.227)
 *
 * บั๊กที่ล็อกออกไป: ห้องที่ยังไม่เปิดให้จองอัตโนมัติ (`ROOM_BOOKING_ROOMS`)
 * ถูกข้าม **โดยไม่เขียนสถานะลง DB** → การ์ดเงียบสนิท → คนที่จอง War Room
 * เข้าใจว่าห้องถูกจองให้แล้วเหมือน Studio เพราะไม่มีอะไรบอกว่าต่างกัน
 * (2026-09-18: 4 ใบ CONFIRMED ที่ War Room ไม่มีห้องจองไว้เลย)
 *
 * และกฎอีกครึ่ง: **ห้ามขึ้นป้ายมั่ว** — งานนอกตึกหรือใบที่ยังไม่กรอกเวลาไม่ใช่
 * เรื่องห้อง ถ้าขึ้นป้ายด้วยจะกลายเป็นเสียงรบกวนจนคนเลิกอ่านป้ายทั้งหมด
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomBadge } from '../room-badge'

test('จองห้องสำเร็จ → ไม่ขึ้นป้าย (ไม่ต้องรบกวน)', () => {
  assert.equal(roomBadge('OK', null), null)
})

test('ยังไม่เคยประมวลผล (null) → ไม่ขึ้นป้าย', () => {
  assert.equal(roomBadge(null, null), null)
  assert.equal(roomBadge(undefined, undefined), null)
})

test('CONFLICT → ป้ายแดง "ห้องไม่ว่าง"', () => {
  const b = roomBadge('CONFLICT', 'ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้วครับ')!
  assert.equal(b.tone, 'busy')
  assert.match(b.label, /ห้องไม่ว่าง/)
  assert.match(b.title, /ถูกจองในช่วงเวลาดังกล่าว/, 'ข้อความจริงจากระบบกลางต้องติดไปใน tooltip')
})

test('INVALID / UNKNOWN → ป้ายเทา "ห้องยังไม่ได้จอง"', () => {
  assert.equal(roomBadge('INVALID', 'x')!.tone, 'pending')
  assert.equal(roomBadge('UNKNOWN', 'timeout')!.tone, 'pending')
})

test('ห้องที่ยังไม่เปิดให้จองอัตโนมัติ → ป้ายฟ้า "ต้องจองห้องเอง" (เคส War Room)', () => {
  const b = roomBadge('SKIPPED', 'skip: room-not-enabled')!
  assert.equal(b.tone, 'manual')
  assert.match(b.label, /ต้องจองห้องเอง/)
  assert.match(b.title, /service\.thestandard\.co/, 'ต้องบอกด้วยว่าไปจองที่ไหน')
})

test('ห้องที่ระบบกลางไม่มีเลย (Lounge) → "ต้องจองห้องเอง" พร้อมเหตุผลของมันเอง', () => {
  const b = roomBadge('SKIPPED', 'skip: no-room-mapping')!
  assert.equal(b.tone, 'manual')
  assert.match(b.title, /ไม่มีในระบบจองส่วนกลาง/)
})

test('งานนอกตึก / ยังไม่เลือกสถานที่ / ยังไม่กรอกเวลา → **ไม่ขึ้นป้าย**', () => {
  // ไม่ใช่สถานการณ์เรื่องห้อง — ขึ้นป้ายด้วยจะกลายเป็นเสียงรบกวน
  for (const r of ['external', 'no-location', 'no-times', 'bad-times', 'disabled', 'already-booked']) {
    assert.equal(roomBadge('SKIPPED', `skip: ${r}`), null, `${r} ไม่ควรขึ้นป้าย`)
  }
})

test('SKIPPED ที่ไม่มีเหตุผลติดมา → ไม่เดา ไม่ขึ้นป้าย', () => {
  assert.equal(roomBadge('SKIPPED', null), null)
  assert.equal(roomBadge('SKIPPED', ''), null)
  assert.equal(roomBadge('SKIPPED', 'อะไรก็ไม่รู้'), null)
})

test('เหตุผลมีช่องว่างเกิน ก็ยังอ่านออก', () => {
  assert.equal(roomBadge('SKIPPED', 'skip:   room-not-enabled  ')!.tone, 'manual')
})

test('สถานะแปลกปลอมไม่ทำให้พัง', () => {
  assert.equal(roomBadge('WHATEVER', 'x'), null)
})
