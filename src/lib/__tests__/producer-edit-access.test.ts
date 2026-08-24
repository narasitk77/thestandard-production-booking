/**
 * v1.193 — กฎ "ใครแก้ใบจองได้แค่ไหน" เคยถูกคัดลอกไว้ 3 ที่ (route producer-edit,
 * หน้า /bookings/:id/edit, ปุ่มในหน้า /my-bookings). v1.188 เปิดโหมด "งาน
 * COMPLETED เติมเลข QU ได้" ที่ 2 ใน 3 ที่ — ลืมปุ่มที่พาไปหน้านั้น ผลบนพรอดคือ
 * 14 ใบไม่มีทางแก้เลย ทั้งที่บอทส่งเมลจี้ให้กลับมาแก้ทุกสัปดาห์
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { producerEditMode, canEditAgencyRef } from '../producer-edit-access'

const AD = { category: 'ADVERTORIAL', authorized: true }
const NEWS = { category: 'NEWS', authorized: true }

test('ไม่ใช่เจ้าของงานและไม่ใช่ทีมคิว = แก้ไม่ได้', () => {
  assert.equal(producerEditMode({ status: 'REQUESTED', category: 'ADVERTORIAL', authorized: false }), 'none')
})

test('REQUESTED = แก้ได้เต็ม', () => {
  assert.equal(producerEditMode({ ...AD, status: 'REQUESTED' }), 'full')
  assert.equal(producerEditMode({ ...NEWS, status: 'REQUESTED' }), 'full')
})

test('CONFIRMED = สถานที่ + Agency Ref', () => {
  assert.equal(producerEditMode({ ...AD, status: 'CONFIRMED' }), 'location')
})

// เคสที่พังจริงบนพรอด
test('COMPLETED + Advertorial = เติมเลข QU ได้', () => {
  assert.equal(producerEditMode({ ...AD, status: 'COMPLETED' }), 'agencyRef')
})

test('COMPLETED ที่ไม่ใช่ Advertorial = แก้ไม่ได้ (ไม่มีเลข QU ให้ใส่)', () => {
  assert.equal(producerEditMode({ ...NEWS, status: 'COMPLETED' }), 'none')
})

test('CANCELLED / ถูกลบ = แก้ไม่ได้เสมอ แม้เป็นงาน Advertorial', () => {
  assert.equal(producerEditMode({ ...AD, status: 'CANCELLED' }), 'none')
  assert.equal(producerEditMode({ ...AD, status: 'COMPLETED', deleted: true }), 'none')
  assert.equal(producerEditMode({ ...AD, status: 'REQUESTED', deleted: true }), 'none')
})

test('สถานะแปลกปลอม = ปิดไว้ก่อน', () => {
  assert.equal(producerEditMode({ ...AD, status: 'ASSIGNED' }), 'none')
  assert.equal(producerEditMode({ ...AD, status: '' }), 'none')
})

// กันไม่ให้โหมดใหม่ถูกเพิ่มแล้วลืมเปิด Agency Ref — ซึ่งคือรากของบั๊ก v1.188
test('ทุกโหมดที่แก้ได้ ต้องแก้ Agency Ref ได้', () => {
  assert.equal(canEditAgencyRef('full'), true)
  assert.equal(canEditAgencyRef('location'), true)
  assert.equal(canEditAgencyRef('agencyRef'), true)
  assert.equal(canEditAgencyRef('none'), false)
})
