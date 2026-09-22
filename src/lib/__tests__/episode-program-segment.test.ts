import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progSegmentForId } from '@/lib/episode-id'

// v1.232 — กฎที่ตัดสินว่า Production ID จะมีชื่อรายการอยู่กลางหรือไม่
//
// บั๊กจริง 2026-09-22: /admin/routine มี dropdown ช่องเดียวแล้วส่งค่าเดียวกันไป
// ทั้ง booking.programCode และ episode.programCode → ค่าหักล้างกัน → สร้าง 135 ใบ
// รหัส WLT-260923-01 ที่ไม่มี MNW เทสชุดนี้ล็อกกฎไว้ไม่ให้พังซ้ำ

test('แยกประเภทตอนกับชื่อรายการถูกต้อง → ชื่อรายการเข้ารหัส', () => {
  assert.equal(progSegmentForId('MNW', 'L'), 'MNW')   // WLT-MNW-260923-01
  assert.equal(progSegmentForId('TSN', 'L'), 'TSN')   // NWS-TSN-260922-01
  assert.equal(progSegmentForId('EVT', 'S'), 'EVT')
})

test('ส่งค่าเดียวกันสองที่ = ผู้เรียกไม่ได้แยก → ไม่มีชื่อรายการในรหัส (บั๊กเดิม)', () => {
  assert.equal(progSegmentForId('MNW', 'MNW'), null)
  assert.equal(progSegmentForId('TSN', 'TSN'), null)
})

test('เทียบแบบไม่สนตัวพิมพ์/ช่องว่าง — mnw กับ MNW คือค่าเดียวกัน', () => {
  assert.equal(progSegmentForId(' mnw ', 'MNW'), null)
  assert.equal(progSegmentForId('MNW', ' l '), 'MNW')
})

test('ประเภทตอน (ยาวตัวเดียว) ไม่เคยกลายเป็นชื่อรายการ', () => {
  assert.equal(progSegmentForId('L', 'S'), null)
  assert.equal(progSegmentForId('A', 'L'), null)
})

test('ค่าว่าง/null/ยาวเกิน 4 → null ไม่ throw', () => {
  assert.equal(progSegmentForId('', 'L'), null)
  assert.equal(progSegmentForId(null, 'L'), null)
  assert.equal(progSegmentForId(undefined, undefined), null)
  assert.equal(progSegmentForId('TOOLONG', 'L'), null)
  assert.equal(progSegmentForId('MN-W', 'L'), null)
})

test('ไม่มี programCode ของใบจอง ก็ยังใส่ชื่อรายการให้ได้', () => {
  assert.equal(progSegmentForId('MNW', null), 'MNW')
})
