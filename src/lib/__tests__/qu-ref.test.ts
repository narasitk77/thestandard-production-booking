// v1.183 — ตัวยึด "ยังไม่มีเลข QU" (คำสั่ง operator 2026-08-20: ใส่ 1234 ได้ไหม)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidQuRef, isQuPending, isAcceptableQuRef, normalizeQuRef, quRefRejectMessage, QU_PENDING,
} from '../qu-ref'

test('ตัวยึดที่ประกาศคือ QU-1234TBC (v1.188) — ผ่านการตรวจ แต่ไม่ใช่เลข QU จริง', () => {
  assert.equal(QU_PENDING, 'QU-1234TBC')
  assert.equal(isQuPending(QU_PENDING), true)
  assert.equal(isAcceptableQuRef(QU_PENDING), true)
  // สำคัญ: ต้องไม่ใช่ "เลขจริง" ไม่งั้นจะถูกดึงไปใส่คิวใหม่ของโปรเจกต์เดียวกัน
  assert.equal(isValidQuRef(QU_PENDING), false)
})

test('1234 เดิม (v1.183) ยังนับเป็นตัวยึด — มีใช้จริงบนพรอดแล้ว', () => {
  assert.equal(isQuPending('1234'), true)
  assert.equal(isAcceptableQuRef('1234'), true)
  assert.equal(isValidQuRef('1234'), false)
})

test('v1.188 — ตัวจับทนการพิมพ์ผิดทุกแบบ (operator: "ต้องเผื่อเวลาเขาใส่ผิดด้วย")', () => {
  for (const typo of [
    'QU-1234TBC', 'qu-1234tbc', 'QU1234TBC', 'QU 1234 TBC', 'QU-1234-TBC', 'qu.1234/tbc',
    '1234TBC', '1234 tbc', 'TBC', 'tbc', 'QU-4480TBC',   // มี TBC = ตัวยึดเสมอ
    '1234', ' 1234 ',                                     // ตัวยึดเดิม v1.183
    'QU-1234', 'QU1234', 'qu 1234',                       // ตก TBC
  ]) {
    assert.equal(isQuPending(typo), true, typo)
    assert.equal(isAcceptableQuRef(typo), true, typo)
    assert.equal(isValidQuRef(typo), false, typo)
  }
})

test('การแลกที่รู้ตัว: QU-1234 ถูกเหมาเป็นตัวยึด', () => {
  // v1.183 เคยกันไว้เพราะอาจเป็นเลขจริง แต่ v1.188 ประกาศ QU-1234TBC เป็นตัวยึด
  // คนพิมพ์ QU-1234 จึงน่าจะตก TBC มากกว่า · พลาดจับของจริง = เตือนเกินแล้วแก้กลับ
  // (เสียงรบกวน) · พลาดไม่จับตัวยึด = งานไม่ถูกตั้งเบิกเงียบ ๆ (แพงกว่า)
  assert.equal(isQuPending('QU-1234'), true)
})

test('ตัวยึดที่ทีมคิดเองก่อนหน้านี้ (QU-1234TBC บนพรอด) ก็นับเป็น "ยังไม่มีเลข"', () => {
  // ของจริง: PP-26-047 / AGN-260824-01,-02 — ผ่าน QU_RE ได้ จึงเคยถูกนับเป็นเลขจริง
  // แล้ว pullQuRefFromProject ลากไปใส่คิวถัดไปเงียบ ๆ
  for (const raw of ['QU-1234TBC', 'QU1234TBC', 'qu-4480tbc']) {
    assert.equal(isQuPending(raw), true, raw)
    assert.equal(isAcceptableQuRef(raw), true, raw)
    // ต้องไม่ใช่ "เลขจริง" อีกต่อไป — ไม่งั้นยังแพร่ไปคิวถัดไปได้
    assert.equal(isValidQuRef(raw), false, raw)
  }
})

test('เลขจริงที่มี TBC ปนไม่ได้ — เลขจริงต้องไม่มี TBC โดยนิยาม', () => {
  // AGN-260721-01 บนพรอดใส่ 'TBC' เปล่า ๆ ไว้ ซึ่งเดิมแก้ไขไม่ได้เลยเพราะตกกฏ
  // v1.188 รับเป็นตัวยึด → เจ้าของงานแก้ต่อได้ และบอทตามจี้ได้
  assert.equal(isQuPending('TBC'), true)
  assert.equal(isAcceptableQuRef('TBC'), true)
  assert.equal(isValidQuRef('QU-4289TBC'), false)
})

test('ตัวยึดทนช่องว่างที่คนพิมพ์ติดมา', () => {
  for (const raw of [' 1234 ', '12 34', '1234\n']) {
    assert.equal(isQuPending(raw), true, JSON.stringify(raw))
  }
})

test('ของที่เคยหลุดเข้ามาจริงยังต้องไม่ผ่านเหมือนเดิม', () => {
  for (const bad of ['PP-26-036-S01', 'LIFE2601', '', '  ', null, undefined, '4289', 'QUOTE-1', 'QU-', 'QU', '0000']) {
    assert.equal(isAcceptableQuRef(bad as any), false, String(bad))
  }
})

test('ทุกรูปแบบ QU ที่ใช้จริงในระบบต้องผ่าน (ไม่ถอยหลัง)', () => {
  for (const ref of ['QU-4289', 'QU-4426-V1', 'QU-2811/2', 'QU-4406', 'QU4289', 'qu-4480']) {
    assert.equal(isValidQuRef(ref), true, ref)
    assert.equal(isAcceptableQuRef(ref), true, ref)
    assert.equal(isQuPending(ref), false, ref)
  }
})

test('normalize เก็บตัวยึดตามที่พิมพ์ — ค้นหา "1234" ใน Agency Ref แล้วต้องเจอ', () => {
  assert.equal(normalizeQuRef('1234'), '1234')
  assert.equal(normalizeQuRef(' qu-4289 '), 'QU-4289')
})

test('ข้อความตีกลับต้องบอกทางออก (ใส่ 1234) ไม่ใช่แค่บอกว่าผิด', () => {
  const msg = quRefRejectMessage('LIFE2601')
  assert.ok(msg.includes('1234'), msg)
  assert.ok(msg.includes('LIFE2601'), msg)
})
