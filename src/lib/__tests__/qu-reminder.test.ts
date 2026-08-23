// v1.187 — เตือน Producer ให้ใส่เลข QU จริง: จังหวะการเตือนคือส่วนที่พลาดแล้วเจ็บ
// (ถี่ไป = สแปมจนคนเลิกอ่าน · ห่างไป = งานถ่ายผ่านไปแล้วยังไม่มีเลข)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsRealQuRef, quUrgency, quReminderDue, groupByProducer, producerDue,
  buildQuReminderEmail, type QuPendingBooking,
} from '../qu-reminder'

const NOW = new Date('2026-08-23T03:00:00Z')
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

test('จับได้ครบทั้ง 3 แบบที่ operator ระบุ: ว่าง / 1234 / TBC', () => {
  for (const bad of ['', '   ', null, undefined, '1234', ' 1234 ', 'QU-1234TBC', 'QU1234TBC', 'qu-4480tbc']) {
    assert.equal(needsRealQuRef(bad as any), true, JSON.stringify(bad))
  }
})

test('เลข QU จริงต้องไม่ถูกเตือน', () => {
  for (const ok of ['QU-4289', 'QU-4426-V1', 'QU-2811/2', 'QU4406', 'qu-4480']) {
    assert.equal(needsRealQuRef(ok), false, ok)
  }
})

test('v1.188 — ตามจี้ทุกแบบที่พิมพ์ผิด รวม QU-1234 ที่ตก TBC', () => {
  for (const typo of ['QU-1234', 'QU 1234 TBC', 'qu.1234/tbc', 'TBC', '1234TBC']) {
    assert.equal(needsRealQuRef(typo), true, typo)
  }
})

test('urgency: ใกล้ถ่ายภายใน 3 วัน = urgent, เลยวันถ่ายแล้ว = normal', () => {
  assert.equal(quUrgency(day(0), NOW), 'urgent')
  assert.equal(quUrgency(day(3), NOW), 'urgent')
  assert.equal(quUrgency(day(4), NOW), 'normal')
  assert.equal(quUrgency(day(30), NOW), 'normal')
  // ถ่ายไปแล้ว: ยังต้องได้เลข แต่ไม่มีเส้นตายกองถ่าย → ไม่เร่ง
  assert.equal(quUrgency(day(-1), NOW), 'normal')
  assert.equal(quUrgency(day(-60), NOW), 'normal')
})

test('ไม่เคยเตือน = เตือนทันที', () => {
  assert.equal(quReminderDue(null, 'normal', NOW), true)
  assert.equal(quReminderDue(undefined, 'urgent', NOW), true)
})

test('ปกติเตือนสัปดาห์ละครั้ง', () => {
  assert.equal(quReminderDue(day(-6), 'normal', NOW), false, '6 วันยังไม่ถึง')
  assert.equal(quReminderDue(day(-7), 'normal', NOW), true, 'ครบ 7 วันแล้วเตือน')
})

test('ใกล้ถ่ายเร่งเป็นทุกวัน', () => {
  assert.equal(quReminderDue(day(-1), 'urgent', NOW), true)
  const halfDayAgo = new Date(NOW.getTime() - 12 * 3_600_000)
  assert.equal(quReminderDue(halfDayAgo, 'urgent', NOW), false, 'ยังไม่ครบวันไม่ส่งซ้ำ')
})

const row = (over: Partial<QuPendingBooking>): QuPendingBooking => ({
  bookingCode: 'AGN-1', agencyRef: '1234', shootDate: day(30), status: 'CONFIRMED',
  producer: 'ไนซ์', producerEmail: 'nice@thestandard.co', quRemindedAt: null, ...over,
})

test('จัดกลุ่มตาม Producer (ไม่สนตัวพิมพ์) — คนเดียวได้ฉบับเดียว', () => {
  const g = groupByProducer([
    row({ bookingCode: 'A', producerEmail: 'Nice@thestandard.co' }),
    row({ bookingCode: 'B', producerEmail: 'nice@thestandard.co' }),
    row({ bookingCode: 'C', producerEmail: 'aom@thestandard.co' }),
  ])
  assert.equal(g.size, 2)
  assert.equal(g.get('nice@thestandard.co')!.length, 2)
})

test('ใบที่ไม่มีอีเมล producer ถูกตัดออก (เตือนไม่ได้) ไม่ใช่ทำให้พัง', () => {
  const g = groupByProducer([
    row({ producerEmail: null }),
    row({ producerEmail: '' }),
    row({ producerEmail: 'ไม่ใช่อีเมล' }),
    row({ producerEmail: 'ok@thestandard.co' }),
  ])
  assert.equal(g.size, 1)
  assert.ok(g.has('ok@thestandard.co'))
})

test('ใบเดียวถึงกำหนด = ส่งทั้งชุด (กันคนเดียวได้หลายฉบับคนละวัน)', () => {
  const rows = [
    row({ bookingCode: 'A', quRemindedAt: day(-1) }),   // ยังไม่ถึง (normal)
    row({ bookingCode: 'B', quRemindedAt: day(-8) }),   // ถึงแล้ว
  ]
  assert.equal(producerDue(rows, NOW), true)
  assert.equal(producerDue([rows[0]], NOW), false)
})

test('เมลบอกสภาพจริงของแต่ละใบ และเรียงตามวันถ่าย', () => {
  const { subject, text } = buildQuReminderEmail([
    row({ bookingCode: 'AGN-LATE', shootDate: day(20), agencyRef: '' }),
    row({ bookingCode: 'AGN-SOON', shootDate: day(1), agencyRef: 'QU-1234TBC' }),
  ], NOW, 'https://probook.xtec9.xyz')
  assert.ok(subject.includes('ด่วน'), 'มีใบใกล้ถ่าย → หัวเรื่องต้องเร่ง')
  assert.ok(text.indexOf('AGN-SOON') < text.indexOf('AGN-LATE'), 'ใกล้ถ่ายขึ้นก่อน')
  assert.ok(text.includes('ยังไม่ได้ใส่'), 'ใบที่ว่างบอกว่าว่าง')
  assert.ok(text.includes('QU-1234TBC'), 'ใบที่ใส่ตัวยึดบอกค่าที่ใส่ไว้')
  assert.ok(text.includes('/my-bookings'), 'บอกที่ที่ไปแก้')
})

test('ไม่มีใบใกล้ถ่าย = หัวเรื่องไม่ตะโกน', () => {
  const { subject } = buildQuReminderEmail([row({ shootDate: day(30) })], NOW, 'https://x')
  assert.ok(!subject.includes('ด่วน'), subject)
})
