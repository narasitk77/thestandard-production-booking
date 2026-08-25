/**
 * v1.195 — ส่วนคำนวณล้วน ๆ ของการเชื่อมระบบจองห้อง (ไม่ยิงเน็ต)
 * เคสเวลาทั้งหมดอ้างอิงเวลาไทย UTC+7 ไม่มี DST
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  roomIdForLocation, bangkokToUtcIso, roomTargetForBooking,
  overlaps, utcRangeToBangkokDates, LOCATION_TO_ROOM_ID,
} from '../room-booking'
import { LOCATIONS } from '../locations'

test('แมปห้องด้วย id เท่านั้น และทุก id ในตารางต้องมีจริงใน locations.ts', () => {
  assert.equal(roomIdForLocation('tsd-studio-1'), 15)
  assert.equal(roomIdForLocation('tsd-b-1-5f'), 17)   // ชื่อในระบบเขาคือ "1 (5/F)"
  assert.equal(roomIdForLocation('tsd-b-hall-5f'), 20) // ชื่อในระบบเขาคือ "Hall B (5/F)"
  for (const id of Object.keys(LOCATION_TO_ROOM_ID)) {
    assert.ok(LOCATIONS.some(l => l.id === id), `${id} ไม่มีใน locations.ts`)
  }
  // roomId ต้องไม่ซ้ำกัน — ซ้ำ = สองห้องของเราไปยึดห้องเดียวกันของเขา
  const ids = Object.values(LOCATION_TO_ROOM_ID)
  assert.equal(new Set(ids).size, ids.length)
})

test('Lounge (2/F) ไม่มีในระบบกลาง → ข้าม ไม่เดา', () => {
  assert.equal(roomIdForLocation('tsd-a-lounge-2f'), null)
  const r = roomTargetForBooking({ locationId: 'tsd-a-lounge-2f', shootDate: '2026-09-01', callTime: '09:00' })
  assert.deepEqual(r, { skip: 'no-room-mapping' })
})

test('เวลาไทย → UTC ISO (สิ่งที่ check-conflict/room-slots ใช้จริง)', () => {
  assert.equal(bangkokToUtcIso('2026-08-27', '13:00'), '2026-08-27T06:00:00.000Z')
  assert.equal(bangkokToUtcIso('2026-09-01', '00:30'), '2026-08-31T17:30:00.000Z')
  assert.equal(bangkokToUtcIso('2026-09-01', 'บ่ายสาม' as any), null)
  assert.equal(bangkokToUtcIso('1/9/2026', '09:00'), null)
})

test('งานปกติ → เป้าหมายการจองครบ', () => {
  const r = roomTargetForBooking({
    locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: '09:00', estimatedWrap: '18:00',
  })
  assert.deepEqual(r, { target: { roomId: 15, startAt: '2026-09-01T02:00:00.000Z', endAt: '2026-09-01T11:00:00.000Z' } })
})

test('ไม่มี wrap → บวก 4 ชั่วโมงเหมือน ot-sync', () => {
  const r = roomTargetForBooking({ locationId: 'tsd-studio-2', shootDate: '2026-09-01', callTime: '09:00' }) as any
  assert.equal(r.target.endAt, '2026-09-01T06:00:00.000Z') // 13:00 BKK = 09:00 + 4 ชม.
})

test('ถ่ายข้ามคืน (wrap <= call) → จบวันถัดไป', () => {
  const r = roomTargetForBooking({
    locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: '20:00', estimatedWrap: '02:00',
  }) as any
  assert.equal(r.target.startAt, '2026-09-01T13:00:00.000Z')
  assert.equal(r.target.endAt, '2026-09-01T19:00:00.000Z') // 2 ก.ย. 02:00 BKK
})

test('เหตุผลที่ข้าม ต้องบอกได้เสมอ', () => {
  assert.deepEqual(roomTargetForBooking({ locationId: null, shootDate: '2026-09-01', callTime: '09:00' }), { skip: 'no-location' })
  assert.deepEqual(roomTargetForBooking({ locationId: 'external-on-location', shootDate: '2026-09-01', callTime: '09:00' }), { skip: 'external' })
  assert.deepEqual(roomTargetForBooking({ locationId: 'tsd-studio-1', shootDate: '2026-09-01', callTime: null }), { skip: 'no-times' })
})

test('overlaps: ปลายชนปลายไม่ถือว่าทับ', () => {
  const a = ['2026-09-01T02:00:00.000Z', '2026-09-01T03:00:00.000Z'] as const
  assert.equal(overlaps(a[0], a[1], '2026-09-01T03:00:00.000Z', '2026-09-01T04:00:00.000Z'), false)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T01:00:00.000Z', '2026-09-01T02:00:00.000Z'), false)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T02:30:00.000Z', '2026-09-01T04:00:00.000Z'), true)
  assert.equal(overlaps(a[0], a[1], '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'), true)
})

test('ช่วง UTC → วันไทยที่พาดผ่าน (ต้องถามช่องว่างให้ครบทุกวัน)', () => {
  assert.deepEqual(utcRangeToBangkokDates('2026-09-01T02:00:00.000Z', '2026-09-01T11:00:00.000Z'), ['2026-09-01'])
  // 1 ก.ย. 20:00 → 2 ก.ย. 02:00 เวลาไทย
  assert.deepEqual(utcRangeToBangkokDates('2026-09-01T13:00:00.000Z', '2026-09-01T19:00:00.000Z'), ['2026-09-01', '2026-09-02'])
})
