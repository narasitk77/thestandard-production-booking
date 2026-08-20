// v1.183 — ตัวยึด "ยังไม่มีเลข QU" (คำสั่ง operator 2026-08-20: ใส่ 1234 ได้ไหม)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidQuRef, isQuPending, isAcceptableQuRef, normalizeQuRef, quRefRejectMessage, QU_PENDING,
} from '../qu-ref'

test('1234 = ตัวยึด "ยังไม่มีเลข QU" — ผ่านการตรวจ แต่ไม่ใช่เลข QU จริง', () => {
  assert.equal(QU_PENDING, '1234')
  assert.equal(isQuPending('1234'), true)
  assert.equal(isAcceptableQuRef('1234'), true)
  // สำคัญ: ต้องยังไม่ใช่ "เลขจริง" ไม่งั้นจะถูกดึงไปใส่คิวใหม่ของโปรเจกต์เดียวกัน
  assert.equal(isValidQuRef('1234'), false)
})

test('ตัวยึดรับเฉพาะ 1234 เปล่า ๆ — QU-1234 ยังนับเป็นเลขใบเสนอราคาจริง', () => {
  // จงใจ: ถ้าเหมา QU-1234 เป็น placeholder แล้ววันหนึ่งมีใบเสนอราคาเลขนี้จริง
  // เราจะทับของจริงโดยไม่มีใครรู้
  assert.equal(isQuPending('QU-1234'), false)
  assert.equal(isQuPending('QU1234'), false)
  assert.equal(isValidQuRef('QU-1234'), true)
  assert.equal(isAcceptableQuRef('QU-1234'), true)
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

test('TBC เปล่า ๆ ยังไม่ผ่าน — เรารับรู้ QU-xxxxTBC ที่มีอยู่แล้ว ไม่ได้เปิดรับของใหม่', () => {
  assert.equal(isQuPending('TBC'), false)
  assert.equal(isAcceptableQuRef('TBC'), false)
})

test('ตัวยึดทนช่องว่างที่คนพิมพ์ติดมา', () => {
  for (const raw of [' 1234 ', '12 34', '1234\n']) {
    assert.equal(isQuPending(raw), true, JSON.stringify(raw))
  }
})

test('ของที่เคยหลุดเข้ามาจริงยังต้องไม่ผ่านเหมือนเดิม', () => {
  for (const bad of ['PP-26-036-S01', 'LIFE2601', 'TBC', '', '  ', null, undefined, '4289', 'QUOTE-1', 'QU-', 'QU', '0000']) {
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
