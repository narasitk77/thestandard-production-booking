// 2026-11-23 (maint round 2, rooms) — room paths that ended quietly.
//
// 1. resyncRoomForBooking returned at once when there was no room number: a CONFLICT job whose owner moved it
//    to a free slot waited up to 6 h (reconcile back-off) for a room; a manual-hold job moved past its hand-made
//    hold was not looked at either. Now it retries at once through syncRoomBooking, claimed like the main path.
// 2. The old room was released after an edit, but the new schedule could not make a room (TSS-SCI-261209-01:
//    'Studio 2 (TSD)' free-typed → locationId NULL → SKIPPED no-location) — silent everywhere. Now ops is told.
// 3. Hub answers: a 200 that is not the shape we expect is "could not tell", never "empty" or "cancelled".
import { test, mock, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

const OWNER = 'p@thestandard.co'
const DAY = '2026-12-16'
let current: any = null
const posted: string[] = []
const alerts: { key: string; text: string }[] = []
const posts: any[] = []
const cancels: string[] = []
let hubRows: any[] = []
let postAnswer: () => Response = () => json({ success: true, bookingNo: 'BK-0900', id: 900 })
let cancelAnswer: () => Response = () => json({ id: 555, bookingNo: 'BK-0555', status: 'cancelled' })
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const matches = (where: any) => Object.entries(where).every(([k, v]) => k === 'id' || current[k] === v)
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => current && { ...current },
        update: async ({ data }: any) => { Object.assign(current, data); return {} },
        // a claim: the main path's `OR` (not RESYNCING / stale) — or the exact fields the retry path read
        updateMany: async ({ where, data }: any) => {
          const ok = where.OR ? current.roomBookingStatus !== 'RESYNCING' : matches(where)
          if (ok) Object.assign(current, data)
          return { count: ok ? 1 : 0 }
        },
      },
    },
  },
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

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/api/liff/bookings-calendar')) return json({ bookings: hubRows })
  if (u.endsWith('/api/liff/booking') && init?.method === 'POST') { posts.push(JSON.parse(init.body)); return postAnswer() }
  if (u.includes('/cancel') && init?.method === 'PATCH') { cancels.push(u); return cancelAnswer() }
  if (u.includes('/api/liff/room-slots')) return json({ error: 'maintenance' })
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
beforeEach(() => {
  posted.length = 0; alerts.length = 0; posts.length = 0; cancels.length = 0; hubRows = []
  postAnswer = () => json({ success: true, bookingNo: 'BK-0900', id: 900 })
  cancelAnswer = () => json({ id: 555, bookingNo: 'BK-0555', status: 'cancelled' })
})

/** fire-and-forget paths — let them settle */
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)) }

const studio = (o: any = {}) => ({
  id: 'b1', bookingCode: 'TSS-SCI-261216-01', shootType: 'STUDIO', locationId: 'tsd-studio-2', locationName: 'Studio 2 (TSD, 1/F)',
  shootDate: new Date(`${DAY}T00:00:00Z`), shootEndDate: null, callTime: '13:00', estimatedWrap: '15:00',
  producer: 'P', producerEmail: OWNER, createdByEmail: OWNER, projectName: null,
  outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { name: 'Show' }, episodes: [],
  roomBookingNo: null, roomBookingRef: null, roomBookingStatus: null, roomBookingError: null,
  status: 'CONFIRMED', deletedAt: null, ...o,
})

test('CONFLICT job moved to a free slot is booked at once, not after the 6 h back-off', async () => {
  current = studio({ roomBookingStatus: 'CONFLICT', roomBookingError: 'ห้องถูกจองแล้ว' })
  sync.resyncRoomForBooking('b1', 'เจ้าของงานแก้: callTime')
  await settle()
  assert.equal(posts.length, 1, 'was: returned at once (no room number to release)')
  assert.equal(current.roomBookingNo, 'BK-0900')
  assert.equal(current.roomBookingStatus, 'OK')
})

test('two saves at once → one POST (claimed like the main path; the hub has no idempotency)', async () => {
  current = studio({ roomBookingStatus: 'CONFLICT', roomBookingError: 'ห้องถูกจองแล้ว' })
  const warn = console.warn
  console.warn = () => {}
  try {
    sync.resyncRoomForBooking('b1', 'a')
    sync.resyncRoomForBooking('b1', 'b')
    await settle()
  } finally { console.warn = warn }
  assert.equal(posts.length, 1)
})

test('manual-hold job moved past its hand-made hold is re-checked at once', async () => {
  // the hold covers 09:00–12:00; the job now runs 13:00–15:00 → not covered → book
  hubRows = [{ id: 144, bookingNo: 'BK-0144', title: 'ถ่ายเอง', roomId: 1, status: 'confirmed', displayName: 'P',
    email: OWNER, startAt: `${DAY}T02:00:00.000Z`, endAt: `${DAY}T05:00:00.000Z` }]
  current = studio({ roomBookingStatus: 'SKIPPED', roomBookingError: 'skip: manual-hold' })
  sync.resyncRoomForBooking('b1', 'เจ้าของงานแก้: callTime')
  await settle()
  assert.equal(posts.length, 1)
  assert.equal(current.roomBookingNo, 'BK-0900')
})

test('an INVALID job the producer just fixed is retried at once (was: up to 6 h)', async () => {
  current = studio({ roomBookingStatus: 'INVALID', roomBookingError: 'hub: bad payload' })
  sync.resyncRoomForBooking('b1', 'เจ้าของงานแก้: callTime')
  await settle()
  assert.equal(posts.length, 1)
})

test('other no-room states are left to the hourly reconcile (no POST)', async () => {
  for (const [s, e] of [['UNKNOWN', 'timeout'], ['SKIPPED', 'skip: no-location'], [null, null]]) {
    current = studio({ roomBookingStatus: s, roomBookingError: e })
    sync.resyncRoomForBooking('b1', 'x')
    await settle()
  }
  assert.equal(posts.length, 0)
})

test('room released after an edit but the new location is not a room → ops is told (room-lost)', async () => {
  current = studio({ locationId: null, locationName: 'Studio 2 (TSD)', roomBookingNo: 'BK-0555', roomBookingRef: 555, roomBookingStatus: 'OK' })
  sync.resyncRoomForBooking('b1', 'เจ้าของงานแก้: locationId')
  await settle()
  assert.equal(cancels.length, 1)
  assert.equal(current.roomBookingNo, null, 'the old room was released')
  assert.equal(current.roomBookingError, 'skip: no-location')
  // v1.291 review: same key as the reconciler's daily room-unresolved alert, so the hourly pass does not repeat it
  assert.deepEqual(alerts.map(a => a.key), ['room-unresolved:TSS-SCI-261216-01'], 'was: silent on every layer')
  assert.match(alerts[0].text, /BK-0555/)
  assert.match(alerts[0].text, /ชื่อสถานที่ "Studio 2 \(TSD\)" ไม่ตรงกับห้องในระบบ/)
})

test('moved out of the building (external) → the room is released on purpose, no alert', async () => {
  current = studio({ locationId: 'external-on-location', locationName: 'ร้านกาแฟ', roomBookingNo: 'BK-0555', roomBookingRef: 555, roomBookingStatus: 'OK' })
  sync.resyncRoomForBooking('b1', 'x')
  await settle()
  assert.equal(cancels.length, 1)
  assert.deepEqual(alerts, [])
})

test('a 200 cancel that does not confirm is "unknown", never "cancelled" (the room number is kept)', async () => {
  for (const body of ['<html>we moved</html>', '{}', '{"error":"x"}']) {
    cancelAnswer = () => new Response(body, { status: 200 })
    assert.equal((await rb.cancelRoomBooking(555)).kind, 'unknown', body)
  }
  cancelAnswer = () => json({ id: 555, bookingNo: 'BK-0555', status: 'cancelled' })
  assert.equal((await rb.cancelRoomBooking(555)).kind, 'ok', 'the IT spec answer')

  // through cancelRoomBookingFor: an unconfirmed 200 must not wipe our number
  cancelAnswer = () => new Response('<html>we moved</html>', { status: 200 })
  current = studio({ roomBookingNo: 'BK-0555', roomBookingRef: 555, roomBookingStatus: 'OK' })
  const r = await sync.cancelRoomBookingFor('b1')
  assert.equal(r.status, 'UNKNOWN')
  assert.equal(current.roomBookingNo, 'BK-0555')
})

test('a 200 read that is not the expected shape throws (callers treat it as "could not read")', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = (async () => json({ masterCalUrl: 'x' })) as any
  try {
    await assert.rejects(rb.listRoomBookings(2026, 12), /รูปคำตอบไม่ถูกต้อง/)
    await assert.rejects(rb.findExistingRoomBooking('X', 2026, 12), /รูปคำตอบไม่ถูกต้อง/)
  } finally { globalThis.fetch = saved }
  await assert.rejects(rb.roomBusySlots(15, DAY), /รูปคำตอบไม่ถูกต้อง/)
})

test('room-schedule places a booking by locationId first (NWS-TSN rows named "สตูดิโอ 1")', () => {
  const src = readFileSync('src/app/admin/room-schedule/page.tsx', 'utf8')
  assert.match(src, /ROOMS\.find\(r => r\.id === b\.locationId\) \?\? ROOMS\.find\(r => r\.fullName === b\.locationName\)/)
})
