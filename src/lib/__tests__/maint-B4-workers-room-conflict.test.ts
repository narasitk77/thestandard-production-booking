// 2026-11-08 maintenance — room reconcile posted a WRONG alert every hour.
//
// A booking whose room came back CONFLICT ("ห้องไม่ว่าง") waits 6h before retrying.
// During that wait it was pushed into staleStuck with bookingNo:null, and every
// hourly run posted to the crew's footage room: "คิวถ่ายยกเลิก/ย้ายไปแล้ว แต่ผม
// ปลดห้องเองไม่ได้ · • null — NWS-TSN-261203-01" — the opposite of the truth (the
// job is live and has NO room), ~20 posts a day per booking. The one correct alert
// already fires from syncRoomBooking on the transition to CONFLICT.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'

const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000)
const shootDate = new Date(Date.UTC(inTwoWeeks.getUTCFullYear(), inTwoWeeks.getUTCMonth(), inTwoWeeks.getUTCDate()))
const row = {
  id: 'b1', bookingCode: 'NWS-TSN-261203-01', status: 'CONFIRMED', deletedAt: null,
  shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00', locationId: 'tsd-studio-1',
  roomBookingNo: null, roomBookingRef: null, roomBookingStatus: 'CONFLICT',
  roomBookingAt: new Date(Date.now() - 3_600_000), roomBookingError: 'ห้องถูกจองแล้ว',
}
mock.module('../db', {
  namedExports: { prisma: { booking: { findMany: async () => [row], update: async () => ({}) } } },
})
const posted: string[] = []
mock.module('../notify', {
  namedExports: {
    notifyChat: async (text: string) => { posted.push(text); return true },
    notifyChatDetailed: async () => ({ discord: false, lark: false, any: false }),
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })

let mod: typeof import('../room-booking-reconcile')
before(async () => { mod = await import('../room-booking-reconcile') })

test('CONFLICT waiting for its 6h retry is reported as waiting, not as a stuck room — and posts nothing', async () => {
  const saved = process.env.ROOM_BOOKING_ENABLED
  process.env.ROOM_BOOKING_ENABLED = '1'
  try {
    const r = await mod.reconcileRoomBookings({ dryRun: false })
    assert.deepEqual(r.conflictWaiting, ['NWS-TSN-261203-01'])
    assert.deepEqual(r.staleStuck, [], 'a live job with no room is not a "stuck room to release"')
    assert.deepEqual(posted, [], 'no hourly "ปลดห้องเองไม่ได้ · null" post')
  } finally {
    if (saved === undefined) delete process.env.ROOM_BOOKING_ENABLED
    else process.env.ROOM_BOOKING_ENABLED = saved
  }
})
