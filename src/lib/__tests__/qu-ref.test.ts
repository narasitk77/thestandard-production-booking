// v1.183 — ตัวยึด "ยังไม่มีเลข QU" (คำสั่ง operator 2026-08-20: ใส่ 1234 ได้ไหม)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isValidQuRef, isQuPending, isAcceptableQuRef, normalizeQuRef, quRefRejectMessage, QU_PENDING, agencyRefForEdit,
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

test('หลายเลข QU คั่นจุลภาคในใบเดียว = เลขจริง (ค่าบนพรอด) — predicate ทั้งสามต้องตรงกัน', async () => {
  const { needsRealQuRef } = await import('../qu-reminder')
  for (const ref of ['QU-4308-V1, QU-4308-V2', 'QU-4308-V3, QU-4308-V4', 'QU-4345, QU-4406', 'QU-3186-V18/ QU-3186-V22']) {
    assert.equal(isValidQuRef(ref), true, ref)
    assert.equal(isAcceptableQuRef(ref), true, ref)
    assert.equal(needsRealQuRef(ref), false, ref)
  }
  // ทุกส่วนต้องเป็นเลข QU — ส่วนที่ว่าง/ไม่ใช่ QU ทำให้ทั้งค่าไม่ผ่าน
  for (const bad of ['QU-4345,', 'QU-4345, PP-26-036', ', QU-4345', 'QU-4345,,QU-4406']) {
    assert.equal(isValidQuRef(bad), false, bad)
    assert.equal(isAcceptableQuRef(bad), false, bad)
  }
  // มีตัวยึดปน = ยังไม่ใช่เลขจริง (ผ่านการตรวจได้ในฐานะตัวยึด)
  assert.equal(isValidQuRef('QU-4345, QU-1234TBC'), false)
  assert.equal(isAcceptableQuRef('QU-4345, QU-1234TBC'), true)
})

test('แก้ใบที่มีอยู่: ตรวจกฎ QU เฉพาะเมื่อค่าเปลี่ยน — ค่าเก่าที่ตกกฎไม่ขวางการบันทึกเรื่องอื่น', () => {
  // 6 ใบ COMPLETED บนพรอดที่แอดมินบันทึกอะไรไม่ได้เลย (หน้า /admin/[id] ส่ง agencyRef ซ้ำทุกครั้ง)
  for (const legacy of ['รอ AE แจ้งค่ะ', 'รอ AE แจ้งอีกทีค่า', 'ซัง', 'แพร']) {
    assert.deepEqual(agencyRefForEdit(legacy, legacy, true), { value: legacy }, legacy)
  }
  // ค่าเก่าที่ตกกฎ ส่งกลับมาต่างแค่ช่องว่าง = ไม่เปลี่ยน → เก็บของเดิมไม่แตะ
  assert.deepEqual(agencyRefForEdit(' รอ AE แจ้งค่ะ', 'รอ AE แจ้งค่ะ', true), { value: 'รอ AE แจ้งค่ะ' })
  // ค่าที่ผ่านกฎเก็บแบบ normalize เสมอ — แก้ช่องว่าง/TAB/ตัวพิมพ์ต้องถึง DB จริง ไม่ใช่ 200 แล้วค่าเก่าค้าง
  // (TSS-OTH-260721-01 เก็บ TAB นำหน้าไว้)
  assert.deepEqual(agencyRefForEdit('QU-4169-V6', '\tQU-4169-V6', true), { value: 'QU-4169-V6' })
  assert.deepEqual(agencyRefForEdit('QU-4405', 'qu-4405', true), { value: 'QU-4405' })
  // v1.291 review: a value sent back untouched is kept byte-for-byte (no "QU4862 → QU-4862" edit nobody made)
  for (const legacy of ['QU4862', 'QU-4345, QU-4406', '\tQU-4169-V6', 'QU-1234TBC'])
    assert.deepEqual(agencyRefForEdit(legacy, legacy, true), { value: legacy }, JSON.stringify(legacy))
  assert.deepEqual(agencyRefForEdit('QU4862 ', 'QU4862', true), { value: 'QU-4862' }, 'a real edit is still normalised')
  // untouched comma value: kept as stored (v1.291 final review — an untouched value is never rewritten)
  assert.deepEqual(agencyRefForEdit('QU-4345, QU-4406', 'QU-4345, QU-4406', true), { value: 'QU-4345, QU-4406' })
  assert.deepEqual(agencyRefForEdit('QU-4345,QU-4406 ', 'QU-4345, QU-4406', true), { value: 'QU-4345,QU-4406' }, 'edited → normalised')
  // เปลี่ยนจริง → ตรวจเหมือนเดิม
  assert.ok('error' in agencyRefForEdit('LIFE2601', 'รอ AE แจ้งค่ะ', true))
  assert.deepEqual(agencyRefForEdit(' qu-4500 ', 'รอ AE แจ้งค่ะ', true), { value: 'QU-4500' })
  assert.deepEqual(agencyRefForEdit('QU-1234TBC', null, true), { value: 'QU-1234TBC' })
  // ลบค่า / กฎไม่ใช้กับใบนี้ (ไม่ใช่ ADVERTORIAL หรือ kill switch) = เก็บตามที่ส่งมา
  assert.deepEqual(agencyRefForEdit('', 'QU-4289', true), { value: null })
  assert.deepEqual(agencyRefForEdit('LIFE2601', null, false), { value: 'LIFE2601' })
})

test('normalize เก็บตัวยึดตามที่พิมพ์ — ค้นหา "1234" ใน Agency Ref แล้วต้องเจอ', () => {
  assert.equal(normalizeQuRef('1234'), '1234')
  assert.equal(normalizeQuRef(' qu-4289 '), 'QU-4289')
})

// รอบ 2 (23 พ.ย.) — ใบเสนอราคาเดียวกันถูกเก็บเป็น QU4862 (AGN-261116-01, -261124-01) และ QU-4862
// (AGN-261117-01) · ค่าใหม่ต้องลงรูปเดียว
test('normalize เติมขีดหลัง QU ทุกส่วนของรายการ — QU4862 กับ QU-4862 เป็นค่าเดียวกัน', () => {
  assert.equal(normalizeQuRef('QU4862'), 'QU-4862')
  assert.equal(normalizeQuRef(' qu 4609 '), 'QU-4609')
  assert.equal(normalizeQuRef('QU4345, qu4406'), 'QU-4345,QU-4406')
  assert.equal(normalizeQuRef('QU-4426-V1'), 'QU-4426-V1')
  assert.equal(normalizeQuRef('QU1234TBC'), 'QU-1234TBC')
  // ไม่ใช่ QU+ตัวเลข = ไม่แตะ
  for (const v of ['1234', 'QUOTE-1', 'LIFE2601', 'TBC']) assert.equal(normalizeQuRef(v), v)
  // ทางบันทึกจริง: ใส่ไม่มีขีดแล้วได้ค่ามีขีด · ค่าเก่าที่ตกกฎยังเทียบ "ไม่เปลี่ยน" ได้เหมือนเดิม
  assert.deepEqual(agencyRefForEdit('QU4862', null, true), { value: 'QU-4862' })
  // ผลการตัดสินไม่เปลี่ยน: รูปไม่มีขีดยังเป็นเลขจริง / ตัวยึดยังเป็นตัวยึด
  assert.equal(isValidQuRef('QU4862'), true)
  assert.equal(isQuPending('QU1234'), true)
  assert.equal(isValidQuRef('QU1234'), false)
})

test('ข้อความตีกลับต้องบอกทางออก (ใส่ 1234) ไม่ใช่แค่บอกว่าผิด', () => {
  const msg = quRefRejectMessage('LIFE2601')
  assert.ok(msg.includes('1234'), msg)
  assert.ok(msg.includes('LIFE2601'), msg)
})

// รอบ 2 (23 พ.ย.) — "ใบนี้ยังไม่มีเลข QU จริง" เคยมีสามคำตอบ: /my-bookings + /dashboard/[id] ใช้ !isValidQuRef,
// /admin/[id] ใช้ isQuPending, บอทเตือนใช้ needsRealQuRef · ตอนนี้มีตัวเดียวใน qu-ref.ts
test('needsRealQuRef อยู่ที่ qu-ref ตัวเดียว — qu-reminder export ตัวเดียวกัน ไม่ใช่สำเนา', async () => {
  const ref = await import('../qu-ref')
  const rem = await import('../qu-reminder')
  assert.equal(rem.needsRealQuRef, ref.needsRealQuRef)
  // เคสที่หน้าแอดมินเคยตอบต่าง: ข้อความไม่มีเลข / ว่าง = ยังไม่มีเลข (isQuPending ตอบ false ทั้งคู่)
  for (const v of ['รอ AE แจ้งค่ะ', '', null]) {
    assert.equal(isQuPending(v), false, String(v))
    assert.equal(ref.needsRealQuRef(v), true, String(v))
  }
})

test('แบนเนอร์ QU ทั้งสามหน้าใช้ needsRealQuRef ไม่ใช่ predicate ตัวอื่น', () => {
  for (const f of ['src/app/my-bookings/page.tsx', 'src/app/dashboard/[id]/page.tsx', 'src/app/admin/[id]/page.tsx']) {
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    assert.match(src, /import \{ needsRealQuRef \} from '@\/lib\/qu-ref'/, f)
    assert.match(src, /needsRealQuRef\(\s*(b|booking)\.agencyRef\s*\)/, f)
    assert.ok(!/\b(isValidQuRef|isQuPending)\b/.test(src), `${f} ยังมี predicate QU ตัวอื่น`)
  }
})

// รอบ 2 (23 พ.ย.) — AGENCY_REF_QU_RULE=0 ปลดแค่ API: ฟอร์มจองบังคับกฎเองเสมอ (step 4 ไปต่อไม่ได้)
// env อ่านในเบราว์เซอร์ไม่ได้ จึงต้องส่งจาก server page ลงไปถึงตัวตรวจ step 4 ครบทุกทอด
test('สวิตช์กฎ QU ส่งจาก /new ถึงตัวตรวจ step 4 ของฟอร์มจอง', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
  assert.match(read('src/app/new/page.tsx'), /<NewBookingClient quRule=\{quRuleEnabled\(\)\} \/>/)
  assert.match(read('src/app/_components/NewBookingClient.tsx'), /<BookingWizard quRule=\{quRule\} \/>/)
  const wiz = read('src/app/_components/booking/BookingWizard.tsx')
  assert.match(wiz, /export default function BookingWizard\(\{ quRule = true \}/)
  assert.match(wiz, /if \(quRule && isAdvertorialBooking\) \{\s*if \(agencyRef\.trim\(\) === ''\)/)
  // ข้อความแดงใต้ช่องก็ต้องเงียบเมื่อปิดกฎ ไม่งั้นฟอร์มบอกว่าผิดแต่ให้ผ่าน
  assert.match(wiz, /\{quRule && agencyRef\.trim\(\) !== '' && !isAcceptableQuRef\(agencyRef\)/)
})
