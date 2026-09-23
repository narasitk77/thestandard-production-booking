// v1.185 — ลิสต์แขกปฏิทิน: แหล่งความจริงที่เดียว (เคยเขียนซ้ำ 4 ที่แล้วเพี้ยนกัน)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingCalendarAttendees } from '../calendar-attendees'

const crew = ['cam1@thestandard.co', 'sound1@thestandard.co']

test('ทีมงาน + Producer + Co-Producer เข้าครบ ทีมงานมาก่อน', () => {
  assert.deepEqual(
    bookingCalendarAttendees({
      assignedEmails: crew,
      producerEmail: 'ingtawan.s@thestandard.co',
      coProducerEmail: 'phoemsiri.p@thestandard.co',
      outletCode: 'TSS',
    }),
    [...crew, 'ingtawan.s@thestandard.co', 'phoemsiri.p@thestandard.co'],
  )
})

test('Co-Producer คือช่องที่หายไปทั้งระบบก่อน v1.185 — ต้องอยู่ในลิสต์', () => {
  const out = bookingCalendarAttendees({ assignedEmails: [], coProducerEmail: 'phoemsiri.p@thestandard.co', outletCode: 'TSS' })
  assert.deepEqual(out, ['phoemsiri.p@thestandard.co'])
})

test('Director เข้าเฉพาะ AGN — กฏ ops v1.146 ที่ assign route เคยไม่มีการ์ด', () => {
  const withDirector = { assignedEmails: crew, directorEmail: 'dir@thestandard.co' }
  assert.ok(bookingCalendarAttendees({ ...withDirector, outletCode: 'AGN' }).includes('dir@thestandard.co'))
  for (const code of ['TSS', 'NWS', 'POP', 'PM', '', null, undefined]) {
    assert.ok(
      !bookingCalendarAttendees({ ...withDirector, outletCode: code as any }).includes('dir@thestandard.co'),
      String(code),
    )
  }
})

test('agn ตัวเล็ก/มีช่องว่าง ก็ยังเป็น AGN', () => {
  for (const code of ['agn', ' AGN ', 'Agn']) {
    assert.ok(bookingCalendarAttendees({ directorEmail: 'dir@thestandard.co', outletCode: code }).includes('dir@thestandard.co'), code)
  }
})

test('dedupe ไม่สนตัวพิมพ์ — Producer ที่ถูก assign เป็นครูด้วยต้องไม่ได้ invite สองใบ', () => {
  const out = bookingCalendarAttendees({
    assignedEmails: ['Ingtawan.S@thestandard.co', 'cam1@thestandard.co'],
    producerEmail: 'ingtawan.s@thestandard.co',
    coProducerEmail: 'INGTAWAN.S@thestandard.co',
    outletCode: 'TSS',
  })
  assert.deepEqual(out, ['Ingtawan.S@thestandard.co', 'cam1@thestandard.co'])
})

test('ค่าว่าง/null/ช่องว่างล้วน ถูกทิ้ง ไม่กลายเป็นแขกผี', () => {
  assert.deepEqual(
    bookingCalendarAttendees({
      assignedEmails: ['', '   ', null as any, 'cam1@thestandard.co', 42 as any],
      producerEmail: '  ', coProducerEmail: null, directorEmail: '', outletCode: 'AGN',
    }),
    ['cam1@thestandard.co'],
  )
})

test('ไม่มีอะไรเลย = ลิสต์ว่าง ไม่ throw', () => {
  assert.deepEqual(bookingCalendarAttendees({}), [])
})

test('เก็บตัวพิมพ์เดิมของอีเมลไว้ (Google เทียบไม่สนตัวพิมพ์ แต่คนอ่าน log สน)', () => {
  assert.deepEqual(bookingCalendarAttendees({ producerEmail: 'Some.One@thestandard.co' }), ['Some.One@thestandard.co'])
})

// ── v1.231 — ผู้กำกับคนที่ 2 และ 3 ────────────────────────────────────────────

test('v1.231 ผู้กำกับคนที่ 2/3 เข้าลิสต์ด้วยเมื่อเป็น AGN', () => {
  assert.deepEqual(
    bookingCalendarAttendees({
      outletCode: 'AGN',
      directorEmail: 'dir1@thestandard.co',
      director2Email: 'dir2@thestandard.co',
      director3Email: 'dir3@thestandard.co',
    }),
    ['dir1@thestandard.co', 'dir2@thestandard.co', 'dir3@thestandard.co'],
  )
})

test('v1.231 การ์ด AGN-only ครอบผู้กำกับทั้งสามคน ไม่ใช่แค่คนแรก', () => {
  // ถ้าใครเผลอเอา director2/3 ออกมานอกบล็อก AGN เทสนี้จะจับได้ทันที
  assert.deepEqual(
    bookingCalendarAttendees({
      outletCode: 'NWS',
      directorEmail: 'dir1@thestandard.co',
      director2Email: 'dir2@thestandard.co',
      director3Email: 'dir3@thestandard.co',
      producerEmail: 'pro@thestandard.co',
    }),
    ['pro@thestandard.co'],
  )
})

test('v1.231 ใส่คนเดิมซ้ำสองช่อง ได้ invite ใบเดียว', () => {
  assert.deepEqual(
    bookingCalendarAttendees({
      outletCode: 'AGN',
      directorEmail: 'dir@thestandard.co',
      director2Email: 'DIR@thestandard.co',
    }),
    ['dir@thestandard.co'],
  )
})

test('v1.231 ใส่เฉพาะคนที่ 3 โดยไม่มีคนที่ 1/2 ก็ยังได้ invite (ไม่ผูกลำดับ)', () => {
  assert.deepEqual(
    bookingCalendarAttendees({ outletCode: 'AGN', director3Email: 'only3@thestandard.co' }),
    ['only3@thestandard.co'],
  )
})

// ── v1.233 — ใบ routine ต้องมีแขกเสมอ ────────────────────────────────────────
//
// reconciler เคยตัดสินว่าจะข้ามใบไหนด้วย assignedEmails (ครูอย่างเดียว) ทั้งที่
// ลิสต์ที่ใช้เชิญจริงคือตัวนี้ · ใบ routine เกิดมาไม่มีครูแต่มี Producer เสมอ
// ถ้าเทสนี้พัง แปลว่าใบ routine กลายเป็น "ไม่มีแขก" แล้ว reconciler จะข้ามมัน
// ทิ้ง = ใบ CONFIRMED ที่ไม่มี event ตลอดไปโดยไม่มีใครเห็น

test('v1.233 ใบ routine (ไม่มีครู แต่มี Producer) ต้องไม่ใช่ลิสต์ว่าง', () => {
  assert.deepEqual(
    bookingCalendarAttendees({
      outletCode: 'NWS',
      assignedEmails: [],
      producerEmail: 'sarut.a@thestandard.co',
    }),
    ['sarut.a@thestandard.co'],
  )
})

test('v1.233 ไม่มีทั้งครู Producer และ Co-Pro = ว่างจริง (เคสเดียวที่ควรข้าม)', () => {
  assert.deepEqual(
    bookingCalendarAttendees({ outletCode: 'NWS', assignedEmails: [], producerEmail: null }),
    [],
  )
})
