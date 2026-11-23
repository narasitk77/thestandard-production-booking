// 2026-11-23 (maint round 2, rooms) — the hourly room reconciler must not look green while it is not working.
//
// 1. A hub month it cannot read was skipped without a count (`if (idx === null) continue`), and a JSON 200
//    without `bookings` read as "this month is empty" → every booked job in the month marked vanished and its
//    room number wiped in one run. Now: unreadable months are listed, nothing is touched.
// 2. Hub reads/books failing (unreadable / UNKNOWN / INVALID) only showed as 'ล้ม=N' in a log line nobody reads
//    (12–19 Oct: 7 days without booking/cancelling). Now one ops alert, CONFLICT excluded (it has its own).
// 3. A studio job whose data cannot make a room (free-typed location → locationId NULL) fell off the end of the
//    loop silently (TSS-SCI-261209-01). Now listed, stamped for the badge, and reminded daily to ops.
// 4. The stale-room alert is keyed on the set of codes: same set = daily repeat, a new set alerts at once.
import { test, mock, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000)
const shootDate = new Date(Date.UTC(inTwoWeeks.getUTCFullYear(), inTwoWeeks.getUTCMonth(), inTwoWeeks.getUTCDate()))
const ymd = shootDate.toISOString().slice(0, 10)

const row = (o: any) => ({
  status: 'CONFIRMED', deletedAt: null, shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00',
  shootType: 'STUDIO', locationId: 'tsd-studio-1', locationName: 'Studio 1 (TSD)',
  producerEmail: 'p@thestandard.co', createdByEmail: 'p@thestandard.co', roomBookingNo: null, roomBookingRef: null,
  roomBookingStatus: null, roomBookingError: null, roomBookingAt: null, ...o,
})

let rows: any[] = []
let syncResult: Record<string, any> = {}
const updates: { id: string; data: any }[] = []
const alerts: { key: string; text: string; everyMs?: number }[] = []
const posted: string[] = []
/** what the hub's bookings-calendar answers (status, body) */
let calendar: () => Response = () => json({ bookings: [] })
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

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
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, _s: string, text: string, everyMs?: number) => {
      alerts.push({ key, text, everyMs }); return { attempted: true, delivered: true, discord: true, lark: false, email: false }
    },
  },
})
mock.module('../room-booking-sync', {
  namedExports: {
    syncRoomBooking: async (id: string) => syncResult[id] ?? { status: 'OK', bookingNo: `BK-${id}` },
    buildPayloadForBooking: (b: any) => ({
      payload: { roomId: 15, title: `[PB-${b.bookingCode}] show`, startDate: ymd, startTime: '09:00', endDate: ymd, endTime: '12:00' },
    }),
    ROOM_BOOKING_SELECT: {},
  },
})

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any) => {
  if (String(url).includes('/api/liff/bookings-calendar')) return calendar()
  throw new Error(`unexpected fetch ${url}`)
}) as any

let mod: typeof import('../room-booking-reconcile')
before(async () => { mod = await import('../room-booking-reconcile') })
after(() => { globalThis.fetch = realFetch })
beforeEach(() => {
  updates.length = 0; alerts.length = 0; posted.length = 0; syncResult = {}
  calendar = () => json({ bookings: [] })
})

async function run(dryRun = false) {
  const saved = { en: process.env.ROOM_BOOKING_ENABLED, rooms: process.env.ROOM_BOOKING_ROOMS, key: process.env.ROOM_BOOKING_SERVICE_KEY }
  process.env.ROOM_BOOKING_ENABLED = '1'
  delete process.env.ROOM_BOOKING_ROOMS
  delete process.env.ROOM_BOOKING_SERVICE_KEY
  const warn = console.warn
  console.warn = () => {}
  try { return await mod.reconcileRoomBookings({ dryRun, max: 5 }) }
  finally {
    console.warn = warn
    for (const [k, v] of [['ROOM_BOOKING_ENABLED', saved.en], ['ROOM_BOOKING_ROOMS', saved.rooms], ['ROOM_BOOKING_SERVICE_KEY', saved.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

const booked = () => row({ id: 'k1', bookingCode: 'KEPT-01', roomBookingNo: 'BK-0700', roomBookingRef: 700, roomBookingStatus: 'OK' })

test('a JSON 200 without `bookings` is "could not read", not "the month is empty" — no room is wiped', async () => {
  calendar = () => json({ masterCalUrl: 'https://hub.thestandard.co/cal' })
  rows = [booked()]
  const r = await run()
  assert.deepEqual(r.vanished, [], 'was: every booked job in the month marked vanished')
  assert.deepEqual(updates, [], 'was: stampCleared wiped roomBookingNo')
  assert.deepEqual(r.unreadable, [`${shootDate.getUTCFullYear()}-${shootDate.getUTCMonth() + 1}`])
})

test('an unreadable month raises ONE ops alert (room-booking-failing); a dry run alerts nobody', async () => {
  calendar = () => new Response('rate limited', { status: 429 })
  rows = [booked(), { ...booked(), id: 'k2', bookingCode: 'KEPT-02', roomBookingNo: 'BK-0701', roomBookingRef: 701 }]
  const r = await run()
  assert.equal(r.unreadable.length, 1, 'one month, listed once')
  assert.deepEqual(alerts.map(a => a.key), ['room-booking-failing'])
  assert.match(alerts[0].text, /อ่านเดือนไม่ได้: \d{4}-\d{1,2}/)

  alerts.length = 0
  const d = await run(true)
  assert.equal(d.unreadable.length, 1, 'the preview reports it too')
  assert.deepEqual(alerts, [])
})

test('UNKNOWN / INVALID raise the failing alert; CONFLICT alone does not (it has its own alerts)', async () => {
  rows = [row({ id: 'u1', bookingCode: 'UNK-01' }), row({ id: 'c1', bookingCode: 'CONF-01' })]
  syncResult = { u1: { status: 'UNKNOWN', message: 'timeout' }, c1: { status: 'CONFLICT', message: 'ห้องถูกจองแล้ว' } }
  await run()
  const failing = alerts.filter(a => a.key === 'room-booking-failing')
  assert.equal(failing.length, 1)
  assert.match(failing[0].text, /UNK-01 UNKNOWN: timeout/)
  assert.doesNotMatch(failing[0].text, /CONF-01/)

  alerts.length = 0
  rows = [row({ id: 'c1', bookingCode: 'CONF-01' })]
  await run()
  assert.deepEqual(alerts.filter(a => a.key === 'room-booking-failing'), [])
})

test('a studio job whose location is not a room is listed, stamped once and reminded daily — not dropped silently', async () => {
  const sci = row({ id: 's1', bookingCode: 'TSS-SCI-261209-01', locationId: null, locationName: 'Studio 2 (TSD)' })
  rows = [sci, row({ id: 'o1', bookingCode: 'OUT-01', shootType: 'ON_LOCATION', locationId: null, locationName: 'ร้านกาแฟ' })]
  const r = await run()
  assert.deepEqual(r.unresolved, [{ code: 'TSS-SCI-261209-01', reason: 'no-location' }], 'an on-location job without a room is normal')
  assert.deepEqual(updates.map(u => [u.id, u.data.roomBookingStatus, u.data.roomBookingError]),
    [['s1', 'SKIPPED', 'skip: no-location']])
  const a = alerts.filter(x => x.key.startsWith('room-unresolved:'))
  assert.deepEqual(a.map(x => x.key), ['room-unresolved:TSS-SCI-261209-01'])
  assert.equal(a[0].everyMs, 24 * 3_600_000)
  assert.match(a[0].text, /ชื่อสถานที่ "Studio 2 \(TSD\)" ไม่ตรงกับห้องในระบบ/)
  assert.match(a[0].text, /hub\.thestandard\.co\/booking/)

  // already stamped → no rewrite (roomBookingAt must not move every hour); still listed and reminded
  updates.length = 0; alerts.length = 0
  rows = [{ ...sci, roomBookingStatus: 'SKIPPED', roomBookingError: 'skip: no-location' }]
  const r2 = await run()
  assert.deepEqual(updates, [])
  assert.equal(r2.unresolved.length, 1)
  assert.equal(alerts.filter(x => x.key.startsWith('room-unresolved:')).length, 1)

  // dry run: listed, nothing written, nobody alerted
  updates.length = 0; alerts.length = 0
  rows = [sci]
  const d = await run(true)
  assert.equal(d.unresolved.length, 1)
  assert.deepEqual(updates, [])
  assert.deepEqual(alerts, [])
})

test('stale-room alert: one message per run, keyed on the set of codes', async () => {
  const stuck = (n: number) => row({ id: `x${n}`, bookingCode: `CANC-0${n}`, status: 'CANCELLED', roomBookingNo: `BK-05${n}0`, roomBookingRef: 500 + n })
  rows = [stuck(1)]
  await run()
  rows = [stuck(1)]
  await run()
  rows = [stuck(1), stuck(2)]
  await run()
  const keys = alerts.filter(a => a.key.startsWith('room-stale:')).map(a => a.key)
  assert.equal(keys.length, 3)
  assert.equal(keys[0], keys[1], 'same set → same key (the 24 h throttle repeats it once a day)')
  assert.notEqual(keys[1], keys[2], 'a new stuck booking alerts at once')
  assert.match(alerts.filter(a => a.key.startsWith('room-stale:'))[2].text, /CANC-01 \(BK-0510\)[\s\S]*CANC-02 \(BK-0520\)/)
  assert.deepEqual(posted, [])
})
