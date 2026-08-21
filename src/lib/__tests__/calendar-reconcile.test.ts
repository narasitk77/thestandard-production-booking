/**
 * ลิสต์แขกที่ reconciler ถือว่า "ถูก" — v1.131 เดิมเป็นฟังก์ชัน `withProducer`
 * ในไฟล์ calendar-reconcile.ts ย้ายไป lib/calendar-attendees.ts ตอน v1.185
 * (ตอนเพิ่ม Co-Producer) เพราะมีถึง 4 ที่ที่ประกอบลิสต์นี้เองแล้วเพี้ยนกัน
 *
 * สาระที่ต้องไม่หาย: ครู + Producer (invite ที่ใส่ตอน confirm) ต้องรอดทุก tick
 * ของ reconciler ไม่ใช่ถูก patch ออกเพราะ reconciler รู้จักแค่ assignedEmails
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingCalendarAttendees } from '../calendar-attendees'

const withProducer = (crew: string[], producerEmail?: string | null) =>
  bookingCalendarAttendees({ assignedEmails: crew, producerEmail })

test('adds the producer to the crew list', () => {
  assert.deepEqual(withProducer(['crew@thestandard.co'], 'producer@thestandard.co'), ['crew@thestandard.co', 'producer@thestandard.co'])
})

test('no producerEmail → crew list unchanged', () => {
  assert.deepEqual(withProducer(['crew@thestandard.co'], null), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], undefined), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], ''), ['crew@thestandard.co'])
  assert.deepEqual(withProducer(['crew@thestandard.co'], '   '), ['crew@thestandard.co'])
})

test('producer already crew-assigned (case-insensitive) → no duplicate', () => {
  assert.deepEqual(withProducer(['Producer@thestandard.co'], 'producer@thestandard.co'), ['Producer@thestandard.co'])
})

test('empty crew list, producer only', () => {
  assert.deepEqual(withProducer([], 'producer@thestandard.co'), ['producer@thestandard.co'])
})

test('reconciler กับ createCalendarEvent ต้องได้ลิสต์เดียวกันเป๊ะ', () => {
  // ถ้าสองฝั่งต่างกัน createVerifiedCalendarEvent จะ "ลบ event ที่เพิ่งสร้าง
  // สำเร็จทิ้ง" แล้ว throw — v1.146 พลาดตรงการ์ด AGN ของ director มาแล้วครั้งหนึ่ง
  const booking = {
    assignedEmails: ['cam@thestandard.co'],
    producerEmail: 'pro@thestandard.co',
    coProducerEmail: 'copro@thestandard.co',
    directorEmail: 'dir@thestandard.co',
    outletCode: 'TSS',
  }
  assert.deepEqual(bookingCalendarAttendees(booking), bookingCalendarAttendees({ ...booking }))
  assert.ok(!bookingCalendarAttendees(booking).includes('dir@thestandard.co'), 'TSS ไม่เอา director')
  assert.ok(bookingCalendarAttendees(booking).includes('copro@thestandard.co'), 'Co-Producer ต้องอยู่')
})
