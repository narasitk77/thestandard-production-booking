// v1.235 — "คีย์ที่ไม่ได้ส่งมา = ไม่เปลี่ยน"
//
// บั๊กที่เทสชุดนี้กัน: ปุ่ม "เพิ่มทีมงานทั้งชุด" (v1.230) ส่งแค่
// {assignedEmails, sendEmail} แต่เราต์เขียน adminNotes/freelancers/
// mainVideographerEmail ลง DB ทุกครั้ง ⇒ กดครั้งเดียวล้างสามฟิลด์ทั้งชุด
// (พรอด 2026-09-24: ใบ routine มี adminNotes 38 ใบ · freelancers 27 ใบ)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAssignPatch } from '../assign-patch'

const existing = {
  assignedEmails: ['video@thestandard.co', 'lead@thestandard.co'],
  adminNotes: 'ลูกค้าขอเทปสำรอง',
  mainVideographerEmail: 'lead@thestandard.co',
  freelancers: [{ name: 'สมชาย', role: 'Gaffer', phone: '', contract: '', email: 'freelance@x.co' }],
}

test('bulk assign (ส่งแค่ assignedEmails) ต้องไม่ล้างโน้ต ฟรีแลนซ์ หรือช่างวิดีโอหลัก', () => {
  const p = resolveAssignPatch(
    { assignedEmails: ['video@thestandard.co', 'lead@thestandard.co'], sendEmail: false },
    existing)
  assert.equal(p.adminNotes, 'ลูกค้าขอเทปสำรอง')
  assert.equal(p.freelancerList.length, 1)
  assert.equal(p.mainVideographerEmail, 'lead@thestandard.co')
})

test('ฟรีแลนซ์เดิมยังอยู่ในลิสต์แขกปฏิทิน แม้ไม่ได้ส่ง freelancers มา', () => {
  const p = resolveAssignPatch({ assignedEmails: ['video@thestandard.co'] }, existing)
  assert.ok(p.emailRecipients.includes('freelance@x.co'),
    'ฟรีแลนซ์หลุดจากลิสต์แขก = Google ส่งใบยกเลิกให้เขาเมื่อ patch แขก')
})

test('ส่ง adminNotes เป็นสตริงว่าง = ตั้งใจล้าง (ฟอร์มเต็มทำได้เหมือนเดิม)', () => {
  const p = resolveAssignPatch(
    { assignedEmails: ['video@thestandard.co'], adminNotes: '', freelancers: [], mainVideographerEmail: null },
    existing)
  assert.equal(p.adminNotes, null)
  assert.deepEqual(p.freelancerList, [])
  assert.equal(p.mainVideographerEmail, null)
})

test('ฟอร์มเต็มเขียนทับได้ทุกฟิลด์ตามเดิม', () => {
  const p = resolveAssignPatch({
    assignedEmails: ['a@x.co'],
    adminNotes: 'โน้ตใหม่',
    freelancers: [{ name: 'ใหม่', email: 'new@x.co' }],
    mainVideographerEmail: 'a@x.co',
  }, existing)
  assert.equal(p.adminNotes, 'โน้ตใหม่')
  assert.deepEqual(p.freelancerList.map(f => f.name), ['ใหม่'])
  assert.equal(p.mainVideographerEmail, 'a@x.co')
  assert.ok(p.emailRecipients.includes('new@x.co'))
})

test('ช่างวิดีโอหลักที่หลุดออกจากลิสต์ ต้องถูกล้าง (กฎเดิม)', () => {
  const p = resolveAssignPatch({ assignedEmails: ['someone.else@x.co'] },
    { ...existing, freelancers: [] })
  assert.equal(p.mainVideographerEmail, null,
    'lead@ ไม่อยู่ในลิสต์แล้ว จะคงไว้ไม่ได้')
})

test('body ว่าง / null ต้องไม่พังและไม่ล้างอะไร — รวมถึงครู', () => {
  // เทสเวอร์ชันแรกของข้อนี้ชื่อว่า "ไม่ล้างอะไร" แต่ assert แค่ adminNotes กับ
  // freelancerList จึงผ่านทั้งที่ emailRecipients ถูกล้างเป็น [] — ตัวตรวจที่ไม่ฟ้อง
  // (bug class 6) รีวิวจับได้ 2026-09-24 · ชื่อเทสต้องตรงกับสิ่งที่มันตรวจจริง
  for (const b of [null, undefined, {}]) {
    const p = resolveAssignPatch(b as any, existing)
    assert.equal(p.adminNotes, 'ลูกค้าขอเทปสำรอง')
    assert.equal(p.freelancerList.length, 1)
    assert.ok(p.emailRecipients.includes('video@thestandard.co'),
      'ไม่ส่ง assignedEmails มา = ต้องคงครูเดิมไว้ ไม่ใช่ล้างทิ้งแล้วส่งใบยกเลิกให้ทุกคน')
    assert.ok(p.emailRecipients.includes('lead@thestandard.co'))
  }
})

test('ส่ง assignedEmails เป็น [] = ตั้งใจล้างครู (ต่างจากไม่ส่งมาเลย)', () => {
  const p = resolveAssignPatch({ assignedEmails: [] }, { ...existing, freelancers: [] })
  assert.deepEqual(p.emailRecipients, [])
})

test('ตัดซ้ำไม่สนตัวพิมพ์ครอบผลรวม staff + freelancer ด้วย', () => {
  const p = resolveAssignPatch(
    { assignedEmails: ['Crew@x.co'], freelancers: [{ name: 'ก', email: 'crew@x.co' }] },
    existing)
  assert.deepEqual(p.emailRecipients, ['Crew@x.co'])
})
