// 2026-11-23 — two room notices that told people the wrong thing, or nothing.
//
// 1. WLT-NGI-261116-01: the producer held War Room by hand 08:00–11:00 for a shoot until 12:00. Not
//    covering the slot = CONFLICT (kept, the last hour really has no room), but the crew notice said
//    "ห้องได้แล้ว ไม่ต้องทำอะไร". It must say what is held and what is missing.
// 2. KND-KNF-261126-01: cancelled while its room was a hand-made hold (BK-0404). releaseRoomForBooking
//    left at once (no roomBookingNo) so the room stayed held for a dead job and nobody was told. Now one
//    alertOps to the operator channel — not the crew chat.
import { test, mock, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const OWNER = 'pidsinee.y@thestandard.co'
const DAY = '2026-12-16'
let current: any = null
let hubRows: any[] = []
const posted: string[] = []
const alerts: { key: string; text: string }[] = []

mock.module('../db', {
  namedExports: { prisma: { booking: { findUnique: async () => current, update: async () => ({}) } } },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../notify', { namedExports: { notifyChat: async (t: string) => { posted.push(t); return true } } })
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, _s: string, text: string) => {
      alerts.push({ key, text }); return { attempted: true, delivered: true, discord: true, lark: false, email: false }
    },
  },
})

// real room-booking: the hub month comes from fetch, the POST answers "room already booked" (HTTP 500)
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/api/liff/bookings-calendar')) {
    return new Response(JSON.stringify({ bookings: hubRows }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (u.endsWith('/api/liff/booking') && init?.method === 'POST') {
    return new Response(JSON.stringify({ error: 'ห้องนี้ถูกจองในช่วงเวลาดังกล่าวแล้วครับ' }), { status: 500 })
  }
  throw new Error(`unexpected fetch ${u}`)
}) as any

let sync: typeof import('../room-booking-sync')
let rb: typeof import('../room-booking')
const saved: Record<string, string | undefined> = {}
before(async () => {
  for (const k of ['ROOM_BOOKING_ENABLED', 'ROOM_BOOKING_ROOMS', 'ROOM_BOOKING_SERVICE_KEY', 'ROOM_BOOKING_BASE_URL']) saved[k] = process.env[k]
  process.env.ROOM_BOOKING_ENABLED = '1'
  process.env.ROOM_BOOKING_SERVICE_KEY = 'test-key'
  delete process.env.ROOM_BOOKING_ROOMS
  delete process.env.ROOM_BOOKING_BASE_URL
  sync = await import('../room-booking-sync')
  rb = await import('../room-booking')
})
after(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
beforeEach(() => { posted.length = 0; alerts.length = 0 })

/** fire-and-forget paths — let them settle */
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }

const warRoomBooking = {
  id: 'b1', bookingCode: 'WLT-NGI-261216-01', locationId: 'tsd-a-war-4f', locationName: 'A · War Room (TSD, 4/F)',
  shootDate: new Date(`${DAY}T00:00:00Z`), shootEndDate: null, callTime: '08:00', estimatedWrap: '12:00',
  producer: 'Ant', producerEmail: OWNER, createdByEmail: OWNER, projectName: null,
  outlet: { code: 'WLT', name: 'Wealth' }, program: { name: 'Show' }, episodes: [],
  roomBookingNo: null, roomBookingStatus: null, roomBookingError: null, status: 'CONFIRMED', deletedAt: null,
}
const hold = (o: any) => ({
  id: 144, bookingNo: 'BK-0144', title: 'ถ่ายเอง', roomId: 2, status: 'confirmed', displayName: 'Ant',
  startAt: `${DAY}T01:00:00.000Z`, endAt: `${DAY}T04:00:00.000Z`, email: OWNER, ...o,   // 08:00–11:00 ไทย
})

test('ownHoldCoverage: held part and missing part of the slot, merged and clipped', () => {
  const t = { startAt: `${DAY}T01:00:00.000Z`, endAt: `${DAY}T05:00:00.000Z` }   // 08:00–12:00
  const r = rb.ownHoldCoverage([
    { startAt: `${DAY}T00:00:00.000Z`, endAt: `${DAY}T02:00:00.000Z`, email: ' Pidsinee.Y@TheStandard.co ' },
    { startAt: `${DAY}T02:00:00.000Z`, endAt: `${DAY}T03:00:00.000Z`, email: OWNER },   // touches → one span
    { startAt: `${DAY}T03:00:00.000Z`, endAt: `${DAY}T05:00:00.000Z`, email: 'other@thestandard.co' },
  ], t, [OWNER, null])!
  assert.deepEqual(r.held.map(([a, b]) => `${rb.bkkTime(a)}–${rb.bkkTime(b)}`), ['08:00–10:00'])
  assert.deepEqual(r.missing.map(([a, b]) => `${rb.bkkTime(a)}–${rb.bkkTime(b)}`), ['10:00–12:00'])
  assert.equal(rb.ownHoldCoverage([{ startAt: t.startAt, endAt: t.endAt, email: 'other@thestandard.co' }], t, [OWNER]), null)
  assert.equal(rb.ownHoldCoverage([{ startAt: t.startAt, endAt: t.endAt, email: OWNER }], t, [null, '']), null, 'no owner email → no guess')
})

test('own hand-made hold not covering the slot → CONFLICT kept, notice says what is held and what is missing', async () => {
  current = { ...warRoomBooking }
  hubRows = [hold({})]
  const r = await sync.syncRoomBooking('b1')
  await settle()
  assert.equal(r.status, 'CONFLICT')
  assert.equal(posted.length, 1)
  assert.match(posted[0], /จองห้องเองไว้ 08:00–11:00 แต่ขาด 11:00–12:00/)
  assert.match(posted[0], /hub\.thestandard\.co\/booking/)
  assert.doesNotMatch(posted[0], /ห้องได้แล้ว ไม่ต้องทำอะไร/)
})

test("someone else's hand-made booking → the old 'if same job' line is unchanged", async () => {
  current = { ...warRoomBooking }
  hubRows = [hold({ email: 'napas.l@thestandard.co', displayName: 'Napas' })]
  await sync.syncRoomBooking('b1')
  await settle()
  assert.equal(posted.length, 1)
  assert.match(posted[0], /ถ้าเป็นงานเดียวกัน ห้องได้แล้ว ไม่ต้องทำอะไร/)
  assert.doesNotMatch(posted[0], /แต่ขาด/)
})

const cancelledHeld = {
  roomBookingNo: null, bookingCode: 'KND-KNF-261126-01', roomBookingError: 'skip: manual-hold',
  locationName: 'A · War Room (TSD, 4/F)', shootDate: new Date('2026-11-26T00:00:00Z'), callTime: '09:00', estimatedWrap: '12:30',
}

test('cancelling a booking whose room was a hand-made hold → one operator alert, no crew post', async () => {
  current = { ...cancelledHeld }
  sync.releaseRoomForBooking('b2', 'booking-cancelled')
  await settle()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, 'room-manual-hold-left:KND-KNF-261126-01')
  assert.match(alerts[0].text,
    /KND-KNF-261126-01 ยกเลิกแล้ว แต่ห้องที่คนของงานจองมือไว้ \(A · War Room \(TSD, 4\/F\) 2026-11-26 09:00–12:30\) ยังอยู่ในระบบกลาง — เจ้าของต้องยกเลิกเอง/)
  assert.deepEqual(posted, [], 'operator channel only — not the team chat')
})

test('no room and no manual hold → release stays silent (nothing to tell)', async () => {
  for (const roomBookingError of [null, 'skip: room-not-enabled', 'skip: external']) {
    current = { ...cancelledHeld, roomBookingError }
    sync.releaseRoomForBooking('b3', 'booking-cancelled')
    await settle()
  }
  assert.deepEqual(alerts, [])
  assert.deepEqual(posted, [])
})
