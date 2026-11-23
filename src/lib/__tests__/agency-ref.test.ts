// v1.161 — กฏ QU ของ Agency ref: รูปแบบอิงข้อมูลจริงในระบบ

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidQuRef, normalizeQuRef } from '../agency-ref'

test('ทุกรูปแบบ QU ที่ใช้จริงในระบบต้องผ่าน', () => {
  for (const ref of ['QU-4289', 'QU-4426-V1', 'QU-2811/2', 'QU-4406', 'QU4289', 'qu-4480']) {
    assert.equal(isValidQuRef(ref), true, ref)
  }
})

test('ของที่เคยหลุดเข้ามาจริงต้องไม่ผ่าน', () => {
  for (const bad of ['PP-26-036-S01', 'LIFE2601', 'TBC', '', '  ', null, undefined, '4289', 'QUOTE-1', 'QU-', 'QU']) {
    assert.equal(isValidQuRef(bad as any), false, String(bad))
  }
})

test('normalize: ตัดช่องว่าง + uppercase + เติมขีดหลัง QU (รอบ 2, 23 พ.ย.: QU4862 กับ QU-4862 ต้องเป็นค่าเดียว)', () => {
  assert.equal(normalizeQuRef(' qu-4289 '), 'QU-4289')
  assert.equal(normalizeQuRef('QU 2811/2'), 'QU-2811/2')
})
