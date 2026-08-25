/**
 * v1.196 — เคสจริงบนพรอด 2026-08-25: โปรดิวเซอร์ของงานมองไม่เห็นงานตัวเอง 59 ใบ
 * เพราะ scope=mine นับแค่ "คนสร้าง หรือ ครูในงาน"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMyBooking, myBookingsWhere, MY_BOOKING_ROLE_FIELDS } from '../my-bookings-scope'
import { isBookingOwner } from '../producer-edit-access'

const ME = 'ingtawan.s@thestandard.co'

test('เป็นโปรดิวเซอร์ของงาน = งานของฉัน แม้คนอื่นเป็นคนสร้าง', () => {
  // TSS-ODK-260820-01 ของจริง: แก้วสร้าง แพรเป็นโปรดิวเซอร์
  assert.equal(isMyBooking({ createdByEmail: 'phoemsiri.p@thestandard.co', producerEmail: ME }, ME), true)
  // WLT-EXI-260826-01 ของจริง: operator สร้าง แอ๊นท์เป็นโปรดิวเซอร์
  const ant = 'pidsinee.y@thestandard.co'
  assert.equal(isMyBooking({ createdByEmail: 'narasit.k@thestandard.co', producerEmail: ant }, ant), true)
})

test('บทบาทอื่นที่นับว่าเป็นงานของฉัน', () => {
  assert.equal(isMyBooking({ createdByEmail: ME }, ME), true)
  assert.equal(isMyBooking({ coProducerEmail: ME }, ME), true)
  assert.equal(isMyBooking({ assignedEmails: ['a@x.co', ME] }, ME), true)
})

test('ไม่เกี่ยวกับงานเลย = ไม่ใช่งานของฉัน', () => {
  assert.equal(isMyBooking({ createdByEmail: 'a@x.co', producerEmail: 'b@x.co', assignedEmails: ['c@x.co'] }, ME), false)
  assert.equal(isMyBooking({ createdByEmail: ME }, ''), false)
  assert.equal(isMyBooking({ createdByEmail: ME }, null), false)
})

test('ไม่สนตัวพิมพ์และช่องว่าง (ข้อมูลจริงมีทั้งสองแบบ)', () => {
  assert.equal(isMyBooking({ producerEmail: '  INGTAWAN.S@thestandard.co ' }, ME), true)
  assert.equal(isMyBooking({ assignedEmails: ['INGTAWAN.S@THESTANDARD.CO'] }, ME), true)
})

// กันสองฝั่งหลุดจากกัน: ทุกบทบาทใน isMyBooking ต้องมีสาขาใน where-clause
test('where-clause ครอบทุกบทบาทที่ isMyBooking นับ', () => {
  const w = myBookingsWhere(ME)
  const keys = w.OR.map(c => Object.keys(c)[0])
  for (const f of MY_BOOKING_ROLE_FIELDS) {
    assert.ok(keys.includes(f), `where-clause ขาด ${f}`)
  }
  assert.equal(keys.length, MY_BOOKING_ROLE_FIELDS.length)
})

// ความสัมพันธ์ที่ต้องจริงเสมอ: แก้ไขได้ ⇒ มองเห็นได้
test('สิทธิ์แก้ไขต้องแคบกว่าหรือเท่ากับสิทธิ์มองเห็นเสมอ', () => {
  const cases = [
    { createdByEmail: ME },
    { producerEmail: ME },
    { createdByEmail: 'a@x.co', producerEmail: ME },
    { createdByEmail: ME, producerEmail: 'b@x.co' },
  ]
  for (const c of cases) {
    if (isBookingOwner(c, ME)) {
      assert.equal(isMyBooking(c, ME), true, `แก้ได้แต่มองไม่เห็น: ${JSON.stringify(c)}`)
    }
  }
  // ครูที่ถูก assign เห็นงานได้ แต่แก้ไม่ได้ — ตั้งใจให้ต่าง
  const crew = { createdByEmail: 'a@x.co', producerEmail: 'b@x.co', assignedEmails: [ME] }
  assert.equal(isMyBooking(crew, ME), true)
  assert.equal(isBookingOwner(crew, ME), false)
})
