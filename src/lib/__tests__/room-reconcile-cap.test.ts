// 2026-11-23 — the hourly reconciler's `max` cap must not be eaten by bookings it cannot or need not book.
//
// Rows come in shootDate asc (fixed order) and `writes >= max` stopped the loop. A booking already stamped
// 'skip: manual-hold' still did writes++ and a syncRoomBooking (one hub GET) every hour, and UNKNOWN /
// INVALID retried every hour too — so ≥max of them at the head of the queue meant later bookings were
// never booked, while the log looked normal (prod ROOM_BOOKING_RECONCILE_MAX=5). INVALID now waits 6 h like
// CONFLICT; UNKNOWN still retries hourly (it may already hold a room) but goes to the back of the queue.
// Also here: Lounge (no-room-mapping) gets its "book it yourself" stamp, and the stale-room notice no
// longer points at the old portal or says "wait for IT".
import { test, mock, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000)
const shootDate = new Date(Date.UTC(inTwoWeeks.getUTCFullYear(), inTwoWeeks.getUTCMonth(), inTwoWeeks.getUTCDate()))
const ymd = shootDate.toISOString().slice(0, 10)
const OWNER = 'owner@thestandard.co'

const row = (o: any) => ({
  status: 'CONFIRMED', deletedAt: null, shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00',
  locationId: 'tsd-studio-1', locationName: 'Studio 1 (TSD)', producerEmail: 'someone@thestandard.co',
  createdByEmail: 'someone@thestandard.co', roomBookingNo: null, roomBookingRef: null,
  roomBookingStatus: null, roomBookingError: null, roomBookingAt: null, ...o,
})
const heldRow = (n: number) => row({
  id: `h${n}`, bookingCode: `HOLD-0${n}`, producerEmail: OWNER, createdByEmail: OWNER,
  roomBookingStatus: 'SKIPPED', roomBookingError: 'skip: manual-hold', roomBookingAt: new Date(Date.now() - 86_400_000),
})

let rows: any[] = []
const synced: string[] = []
const updates: { id: string; data: any }[] = []
const posted: string[] = []
let hubGets = 0
let hubDown = false

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async () => rows,
        update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return {} },
      },
    },
  },
})
mock.module('../notify', { namedExports: { notifyChat: async (t: string) => { posted.push(t); return true } } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
const alerts: { key: string; text: string; everyMs?: number }[] = []
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, _s: string, text: string, everyMs?: number) => {
      alerts.push({ key, text, everyMs }); return { attempted: true, delivered: true, discord: true, lark: false, email: false }
    },
  },
})
mock.module('../room-booking-sync', {
  namedExports: {
    syncRoomBooking: async (id: string) => { synced.push(id); return { status: 'OK', bookingNo: `BK-${id}` } },
    buildPayloadForBooking: (b: any) => ({
      payload: { roomId: 15, title: `[PB-${b.bookingCode}] show`, startDate: ymd, startTime: '09:00', endDate: ymd, endTime: '12:00' },
    }),
    ROOM_BOOKING_SELECT: {},
  },
})

// the real room-booking module reads the hub month through fetch — the owner's manual hold covers 09:00–12:00
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any) => {
  if (String(url).includes('/api/liff/bookings-calendar')) {
    hubGets++
    if (hubDown) return new Response('rate limited', { status: 429 })
    return new Response(JSON.stringify({
      bookings: [{
        id: 900, bookingNo: 'BK-0404', title: 'อัดรายการเอง', roomId: 15, status: 'confirmed',
        startAt: `${ymd}T02:00:00.000Z`, endAt: `${ymd}T05:00:00.000Z`, displayName: 'Owner', email: OWNER,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as any

let mod: typeof import('../room-booking-reconcile')
before(async () => { mod = await import('../room-booking-reconcile') })
beforeEach(() => { synced.length = 0; updates.length = 0; posted.length = 0; alerts.length = 0; hubGets = 0; hubDown = false })

async function run(opts: { dryRun?: boolean; max?: number } = {}) {
  const saved = { en: process.env.ROOM_BOOKING_ENABLED, rooms: process.env.ROOM_BOOKING_ROOMS, key: process.env.ROOM_BOOKING_SERVICE_KEY }
  process.env.ROOM_BOOKING_ENABLED = '1'
  delete process.env.ROOM_BOOKING_ROOMS
  delete process.env.ROOM_BOOKING_SERVICE_KEY
  const warn = console.warn
  console.warn = () => {}
  try { return await mod.reconcileRoomBookings({ dryRun: opts.dryRun ?? false, max: opts.max ?? 5 }) }
  finally {
    console.warn = warn
    for (const [k, v] of [['ROOM_BOOKING_ENABLED', saved.en], ['ROOM_BOOKING_ROOMS', saved.rooms], ['ROOM_BOOKING_SERVICE_KEY', saved.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

test('5 manual-hold bookings at the head of the queue do not eat max=5 — the normal booking is booked in the same run', async () => {
  rows = [1, 2, 3, 4, 5].map(heldRow).concat(row({ id: 'n1', bookingCode: 'NORMAL-01' }))
  const r = await run({ max: 5 })
  assert.deepEqual(synced, ['n1'], 'only the normal booking goes through syncRoomBooking')
  assert.deepEqual(r.booked, [{ code: 'NORMAL-01', bookingNo: 'BK-n1' }])
  assert.equal(r.deferred, 0)
  assert.equal(hubGets, 1, 'one cached month read for all five holds, not one GET each')
  assert.deepEqual(updates, [], 'an unchanged manual-hold is not re-stamped')
})

test('a stamped manual-hold whose hold is gone is booked again (falls through to syncRoomBooking)', async () => {
  rows = [row({ id: 'h9', bookingCode: 'HOLD-09', roomBookingStatus: 'SKIPPED', roomBookingError: 'skip: manual-hold' })]
  // producer is not the hold's owner → manualHeld finds nothing
  await run()
  assert.deepEqual(synced, ['h9'])
})

test('INVALID waits 6 h (still reported); UNKNOWN retries every run but after fresh bookings', async () => {
  // UNKNOWN = "outcome not known, re-read next run" — a POST that timed out may already hold a room, so it must
  // be adopted within the hour (cancelled meanwhile = no number to release = room stuck). It must not wait 6 h,
  // and it must not take the cap ahead of a fresh booking either.
  const hourAgo = new Date(Date.now() - 3_600_000)
  rows = [
    row({ id: 'u1', bookingCode: 'UNK-01', roomBookingStatus: 'UNKNOWN', roomBookingError: 'timeout', roomBookingAt: hourAgo }),
    row({ id: 'i1', bookingCode: 'INV-01', roomBookingStatus: 'INVALID', roomBookingError: 'HTTP 401', roomBookingAt: hourAgo }),
    row({ id: 'n1', bookingCode: 'NORMAL-01' }),
  ]
  const r = await run({ max: 1 })
  assert.deepEqual(synced, ['n1'], 'the fresh booking gets the cap, not the UNKNOWN ahead of it')
  assert.equal(r.deferred, 1, 'the UNKNOWN at the tail is counted, not dropped silently')
  assert.deepEqual(r.failed.map(f => [f.code, f.status]), [['INV-01', 'INVALID']])
  assert.match(r.failed[0].message!, /รอลองใหม่.*HTTP 401/)

  synced.length = 0
  const r2 = await run({ max: 2 })
  assert.deepEqual(synced, ['n1', 'u1'], 'UNKNOWN from an hour ago is retried now, not in 6 h')
  assert.equal(r2.deferred, 0)

  // the preview says the same thing (dry-run must match real)
  synced.length = 0
  const d = await run({ dryRun: true, max: 2 })
  assert.deepEqual(d.failed.map(f => f.code), ['INV-01'])
  assert.deepEqual(d.booked.map(b => b.code), ['NORMAL-01', 'UNK-01'])
  assert.deepEqual(synced, [])
})

test('INVALID past the 6 h window retries', async () => {
  rows = [row({ id: 'i2', bookingCode: 'INV-02', roomBookingStatus: 'INVALID', roomBookingError: 'HTTP 401', roomBookingAt: new Date(Date.now() - 7 * 3_600_000) })]
  await run()
  assert.deepEqual(synced, ['i2'])
})

test('a stamped manual-hold is left alone when the hub month cannot be read (not re-stamped UNKNOWN)', async () => {
  // can't read = can't decide: falling through to syncRoomBooking would most likely fail the same read and stamp
  // UNKNOWN over a hold that is really there → false "room not booked" badge
  hubDown = true
  rows = [heldRow(1), row({ id: 'n1', bookingCode: 'NORMAL-01' })]
  const r = await run()
  assert.deepEqual(synced, ['n1'], 'the held booking does not go to syncRoomBooking; the normal one still does')
  assert.deepEqual(updates, [])
  assert.deepEqual(r.failed.map(f => [f.code, f.status]), [['HOLD-01', 'UNKNOWN']])
  assert.match(r.failed[0].message!, /อ่านระบบกลางไม่ได้/)

  synced.length = 0
  const d = await run({ dryRun: true })
  assert.deepEqual(d.failed.map(f => f.code), ['HOLD-01'], 'preview matches the real run')
  assert.deepEqual(d.booked.map(b => b.code), ['NORMAL-01'])
})

test('hitting max reports how many bookings were not reached', async () => {
  rows = [1, 2, 3].map(n => row({ id: `n${n}`, bookingCode: `NORMAL-0${n}` }))
  const r = await run({ max: 1 })
  assert.deepEqual(synced, ['n1'])
  assert.equal(r.deferred, 2)
})

test('Lounge (no-room-mapping) gets its "book it yourself" stamp once, without using the cap', async () => {
  const lounge = row({ id: 'l1', bookingCode: 'LOUNGE-01', locationId: 'tsd-a-lounge-2f', locationName: 'A · Lounge (TSD, 2/F)' })
  rows = [lounge, row({ id: 'n1', bookingCode: 'NORMAL-01' })]
  const r = await run({ max: 1 })
  assert.deepEqual(updates.map(u => [u.id, u.data.roomBookingStatus, u.data.roomBookingError]),
    [['l1', 'SKIPPED', 'skip: no-room-mapping']])
  assert.deepEqual(synced, ['n1'], 'the stamp is not a write against the hub')
  assert.equal(r.deferred, 0)

  // already stamped → not rewritten (roomBookingAt must not move every hour)
  updates.length = 0
  rows = [{ ...lounge, roomBookingStatus: 'SKIPPED', roomBookingError: 'skip: no-room-mapping' }]
  await run()
  assert.deepEqual(updates, [])

  // dry run writes nothing
  rows = [lounge]
  await run({ dryRun: true })
  assert.deepEqual(updates, [])
})

test('stale-room notice links the hub portal and no longer says "wait for IT"', async () => {
  // cancelled booking still holding a room; no service key → cancel is forbidden → staleStuck → notice
  // 2026-11-23 — the notice is an ops alert now (throttled, delivery checked), not an hourly crew-room post,
  // and each line carries that booking's own reason instead of a fixed "cancelled/moved" heading
  rows = [row({ id: 'c1', bookingCode: 'CANC-01', status: 'CANCELLED', roomBookingNo: 'BK-0555', roomBookingRef: 555 })]
  const r = await run()
  assert.equal(r.staleStuck.length, 1)
  assert.deepEqual(posted, [], 'no hourly crew-room post')
  const stale = alerts.filter(a => a.key.startsWith('room-stale:'))
  assert.equal(stale.length, 1)
  assert.match(stale[0].text, /https:\/\/hub\.thestandard\.co\/booking/)
  assert.doesNotMatch(stale[0].text, /service\.thestandard\.co|รอ IT|คิวถ่ายยกเลิก\/ย้ายไปแล้ว/)
  assert.match(stale[0].text, /CANC-01 \(BK-0555\) — คีย์ยังไม่มีสิทธิ์ยกเลิก/)
  assert.equal(stale[0].everyMs, 24 * 3_600_000)
})

after(() => { globalThis.fetch = realFetch })
