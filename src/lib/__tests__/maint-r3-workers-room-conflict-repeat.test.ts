// maint r3 2026-11-08 — a booking still waiting on a room CONFLICT gets a correctly worded repeat.
//
// HEAD nagged the crew room every hour for these (wrong text: "คิวยกเลิก/ย้ายไปแล้ว … null"). Round 1 cut the
// nag (only the one-time transition notice was left) — a prod behaviour removed without Nat's go. Now: one
// alertOps per booking, key room-conflict-waiting:<code>, throttled 24 h, saying the job has NO room yet — for
// rows waiting out the 6 h retry AND rows whose retry this run is still CONFLICT. A dry run alerts nothing.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000)
const shootDate = new Date(Date.UTC(inTwoWeeks.getUTCFullYear(), inTwoWeeks.getUTCMonth(), inTwoWeeks.getUTCDate()))
const base = {
  status: 'CONFIRMED', deletedAt: null, shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00',
  locationId: 'tsd-studio-1', locationName: 'Studio 1', roomBookingNo: null, roomBookingRef: null,
  roomBookingStatus: 'CONFLICT', roomBookingError: 'ห้องถูกจองแล้ว',
}
let rows: any[] = []
const bothRows = [
  // waiting out the 6 h retry window
  { ...base, id: 'b1', bookingCode: 'NWS-TSN-261203-01', roomBookingAt: new Date(Date.now() - 3_600_000) },
  // window passed → retried this run → still CONFLICT
  { ...base, id: 'b2', bookingCode: 'NWS-TSN-261203-02', roomBookingAt: new Date(Date.now() - 7 * 3_600_000) },
]
const alerts: { key: string; text: string; everyMs?: number }[] = []
const posted: string[] = []
mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => rows, update: async () => ({}) } } } })
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
    syncRoomBooking: async () => ({ status: 'CONFLICT', message: 'ห้องถูกจองแล้ว' }),
    buildPayloadForBooking: () => ({ payload: { roomId: 1, title: 't', startDate: '2026-12-03', startTime: '09:00', endDate: '2026-12-03', endTime: '12:00' } }),
    ROOM_BOOKING_SELECT: {},
  },
})

let mod: typeof import('../room-booking-reconcile')
before(async () => { mod = await import('../room-booking-reconcile') })
beforeEach(() => { alerts.length = 0; posted.length = 0; rows = bothRows })

async function run(dryRun: boolean) {
  const saved = process.env.ROOM_BOOKING_ENABLED
  process.env.ROOM_BOOKING_ENABLED = '1'
  try { return await mod.reconcileRoomBookings({ dryRun }) }
  finally { if (saved === undefined) delete process.env.ROOM_BOOKING_ENABLED; else process.env.ROOM_BOOKING_ENABLED = saved }
}

test('every booking still without a room gets ONE correctly worded reminder, throttled per code at 24 h', async () => {
  const r = await run(false)
  assert.deepEqual(r.conflictWaiting, ['NWS-TSN-261203-01'])
  assert.deepEqual(r.failed.map((f) => [f.code, f.status]), [['NWS-TSN-261203-02', 'CONFLICT']])
  assert.deepEqual(alerts.map((a) => a.key), ['room-conflict-waiting:NWS-TSN-261203-01', 'room-conflict-waiting:NWS-TSN-261203-02'])
  for (const a of alerts) {
    assert.equal(a.everyMs, mod.ROOM_CONFLICT_REPEAT_MS)
    assert.match(a.text, /ยังไม่มีห้อง — ห้องที่ขอไม่ว่าง/)
    assert.match(a.text, /Studio 1/)
    assert.doesNotMatch(a.text, /ยกเลิก\/ย้ายไปแล้ว|null/, 'not the old wrong "stuck room" wording')
  }
  assert.equal(mod.ROOM_CONFLICT_REPEAT_MS, 24 * 3_600_000)
  assert.deepEqual(posted, [], 'no hourly crew-room post (that was the wrong-text nag)')
})

test('a dry run reminds nobody', async () => {
  // only the waiting row: a dry run of the retried row reads the live portal (manualHeld) — no network in tests
  rows = [bothRows[0]]
  const r = await run(true)
  assert.deepEqual(r.conflictWaiting, ['NWS-TSN-261203-01'])
  assert.deepEqual(alerts, [])
})
