/**
 * "คนของงานนี้จองห้องเองไปแล้ว" (v1.227)
 *
 * เจอตอนกำลังจะเปิด War Room ให้จองอัตโนมัติ (2026-09-18): War Room มี 5 ใบรอจอง
 * และ **2 ใบในนั้นโปรดิวเซอร์เจ้าของงานจองห้องด้วยมือไปแล้ว เวลาตรงกันเป๊ะ**
 * เพราะก่อนหน้านี้โปรบุ๊คไม่ได้จองให้ ถ้าเปิดห้องดิบ ๆ ผลคือ CONFLICT + ป้าย
 * "⚠ ห้องไม่ว่าง" บนงานที่ห้องถูกกันไว้ถูกต้องแล้ว — สัญญาณหลอกตั้งแต่วันแรก
 * ซึ่งสอนให้คนเลิกเชื่อป้ายทั้งระบบ
 *
 * เส้นที่ต้องไม่ข้าม: **รับเฉพาะที่ห้องถูกกันไว้ให้จริง** ครอบไม่หมดช่วง หรือคนละคนจอง
 * = ชนของจริง ต้องปล่อยให้เป็น CONFLICT ให้คนมาจัดการ ห้ามกลืนหาย
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findManualHold } from '../room-booking'

const OWNER = 'pidsinee.y@thestandard.co'
const row = (o: any = {}) => ({
  bookingNo: 'BK-9', live: true, roomId: 2, isProbook: false,
  startAt: '2026-09-22T01:00:00.000Z', endAt: '2026-09-22T04:00:00.000Z',  // 08:00–11:00 ไทย
  bookedBy: 'Ant', email: OWNER, ...o,
})
// งานถ่าย 08:00–11:00 ไทย
const T = { roomId: 2, startAt: '2026-09-22T01:00:00.000Z', endAt: '2026-09-22T04:00:00.000Z' }

test('เคสจริง WLT-NGI: โปรดิวเซอร์จองห้องเองไว้ เวลาตรงเป๊ะ → รับว่าห้องได้แล้ว', () => {
  const h = findManualHold([row()], T, [OWNER])!
  assert.equal(h.bookingNo, 'BK-9')
  assert.equal(h.bookedBy, 'Ant')
})

test('จองครอบกว้างกว่าเวลาถ่าย → ยังนับว่าห้องได้แล้ว', () => {
  const wide = row({ startAt: '2026-09-22T00:00:00.000Z', endAt: '2026-09-22T06:00:00.000Z' })
  assert.ok(findManualHold([wide], T, [OWNER]))
})

test('**ครอบไม่หมดช่วงถ่าย → ไม่รับ** — ห้องไม่ได้ถูกกันไว้จริง', () => {
  const short = row({ endAt: '2026-09-22T02:00:00.000Z' })   // เลิก 09:00 แต่ถ่ายถึง 11:00
  assert.equal(findManualHold([short], T, [OWNER]), null)
  const late = row({ startAt: '2026-09-22T02:00:00.000Z' })  // เริ่ม 09:00 แต่ถ่ายตั้งแต่ 08:00
  assert.equal(findManualHold([late], T, [OWNER]), null)
})

test('**คนอื่นจอง → ไม่รับ** นี่คือชนของจริง', () => {
  assert.equal(findManualHold([row({ email: 'napas.l@thestandard.co' })], T, [OWNER]), null)
})

test('ห้องอื่นไม่นับ', () => {
  assert.equal(findManualHold([row({ roomId: 15 })], T, [OWNER]), null)
})

test('รายการที่ยกเลิกแล้วไม่นับ', () => {
  assert.equal(findManualHold([row({ live: false })], T, [OWNER]), null)
})

test('ใบที่โปรบุ๊คจองให้ **งานอื่นของคนเดียวกัน** นับเข้าผลรวมได้ (v1.227.3)', () => {
  // พื้นที่จริงถูกกันไว้แล้ว ไม่ว่าใบไหนเป็นคนกัน — ใบของ *งานนี้เอง* ต่างหากที่ต้องไม่นับ
  // (ดูเทส "ใบของงานตัวเองไม่นับ") ซึ่งทางนั้นมี marker จัดการอยู่ก่อนแล้ว
  assert.ok(findManualHold([row({ isProbook: true, title: '[PB-OTHER-JOB-01] อีกกองหนึ่ง' })],
                           T, [OWNER], '[PB-WLT-NGI-260922-01]'))
})

test('ไม่รู้อีเมลเจ้าของงาน → ไม่เดา ไม่รับ', () => {
  assert.equal(findManualHold([row()], T, [null, undefined, '']), null)
  assert.equal(findManualHold([row()], T, ['ไม่ใช่อีเมล']), null)
})

test('อีเมลตัวพิมพ์ใหญ่/มีช่องว่างก็ยังจับคู่ได้', () => {
  assert.ok(findManualHold([row({ email: '  Pidsinee.Y@TheStandard.co ' })], T, [OWNER]))
})

test('คนเปิดใบ (ไม่ใช่โปรดิวเซอร์) จองเองก็นับ', () => {
  const h = findManualHold([row({ email: 'aphisit.h@thestandard.co' })], T,
                           [OWNER, 'aphisit.h@thestandard.co'])
  assert.ok(h)
})

/**
 * v1.227.3 — ต้องดู "ผลรวม" ของห้องที่คนกลุ่มเดียวกันกันไว้ ไม่ใช่ทีละใบ
 *
 * เคสจริง TSS-GEB-260929-01: แพรมีสองกองติดกันใน Studio 1 วันเดียว
 * โปรบุ๊คจองกองแรกไว้ 09:00–13:00 เธอจองกองนี้เองไว้ 13:00–16:00
 * ห้องจึงเป็นของเธอต่อเนื่อง 09:00–16:00 แต่ไม่มีใบไหนครอบ 12:30–16:00 ได้คนเดียว
 * → เดิมตกเป็น CONFLICT → ป้ายแดงค้าง + retry ทุก 6 ชม. ตลอดกาลโดยไม่มีวันสำเร็จ
 */
const GEB = { roomId: 15, startAt: '2026-09-29T05:30:00.000Z', endAt: '2026-09-29T09:00:00.000Z' } // 12:30–16:00
const PARE = 'ingtawan.s@thestandard.co'

test('เคสจริงแพร: สองใบต่อกันครอบช่วงถ่ายได้ → นับว่าห้องถูกกันไว้แล้ว', () => {
  const rows = [
    // โปรบุ๊คจองให้กองแรก 09:00–13:00
    row({ bookingNo: 'BK-0088', roomId: 15, isProbook: true, email: PARE, bookedBy: 'แพร',
          title: '[PB-TSS-TSS-260929-01] TSS · The Secret Sauce',
          startAt: '2026-09-29T02:00:00.000Z', endAt: '2026-09-29T06:00:00.000Z' }),
    // แพรจองกองนี้เองไว้ 13:00–16:00
    row({ bookingNo: 'BK-0145', roomId: 15, isProbook: false, email: PARE, bookedBy: 'Ingtawan Suwansupa',
          startAt: '2026-09-29T06:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z' }),
  ]
  const h = findManualHold(rows, GEB, [PARE], '[PB-TSS-GEB-260929-01]')!
  assert.ok(h, 'ห้องเป็นของเธอต่อเนื่องทั้งวัน ต้องไม่ตกเป็น CONFLICT')
  assert.equal(h.bookingNo, 'BK-0088', 'ป้ายชื่อใบที่ทับช่วงถ่ายและยาวที่สุด')
})

test('ต่อกันแต่ยังมีรู → ไม่รับ (ห้องไม่ได้ถูกกันไว้จริงทั้งช่วง)', () => {
  const rows = [
    row({ bookingNo: 'A', roomId: 15, email: PARE,
          startAt: '2026-09-29T02:00:00.000Z', endAt: '2026-09-29T05:00:00.000Z' }),  // จบ 12:00
    row({ bookingNo: 'B', roomId: 15, email: PARE,
          startAt: '2026-09-29T06:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z' }),  // เริ่ม 13:00
  ]
  // เหลือรู 12:00–13:00 คร่อมเวลาเรียก 12:30
  assert.equal(findManualHold(rows, GEB, [PARE], null), null)
})

test('**ใบของงานตัวเองไม่นับเป็น "คนกันไว้ให้"**', () => {
  const rows = [row({ bookingNo: 'SELF', roomId: 15, isProbook: true, email: PARE,
                      title: '[PB-TSS-GEB-260929-01] TSS · Global Economic Background',
                      startAt: '2026-09-29T05:00:00.000Z', endAt: '2026-09-29T10:00:00.000Z' })]
  assert.equal(findManualHold(rows, GEB, [PARE], '[PB-TSS-GEB-260929-01]'), null)
  // ถ้าไม่ใช่ใบของงานนี้ ก็นับได้ตามปกติ
  assert.ok(findManualHold(rows, GEB, [PARE], '[PB-OTHER-01]'))
})

test('ผลรวมของคนอื่นไม่ช่วย — ต้องเป็นคนของงานนี้เท่านั้น', () => {
  const rows = [
    row({ bookingNo: 'X', roomId: 15, email: 'napas.l@thestandard.co',
          startAt: '2026-09-29T02:00:00.000Z', endAt: '2026-09-29T06:00:00.000Z' }),
    row({ bookingNo: 'Y', roomId: 15, email: 'napas.l@thestandard.co',
          startAt: '2026-09-29T06:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z' }),
  ]
  assert.equal(findManualHold(rows, GEB, [PARE], null), null)
})

test('ใบที่ยกเลิกแล้วไม่นับเข้าผลรวม', () => {
  const rows = [
    row({ bookingNo: 'A', roomId: 15, email: PARE, live: false,
          startAt: '2026-09-29T02:00:00.000Z', endAt: '2026-09-29T06:00:00.000Z' }),
    row({ bookingNo: 'B', roomId: 15, email: PARE,
          startAt: '2026-09-29T06:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z' }),
  ]
  assert.equal(findManualHold(rows, GEB, [PARE], null), null)
})

test('ข้อมูลเวลาพังไม่ทำให้ล่ม', () => {
  assert.equal(findManualHold([row({ startAt: null })], T, [OWNER]), null)
  assert.equal(findManualHold([row({ endAt: 'ไม่ใช่เวลา' })], T, [OWNER]), null)
  assert.equal(findManualHold([row()], { ...T, startAt: 'พัง' }, [OWNER]), null)
})
