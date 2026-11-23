// 2026-11-23 — /api/internal/room-conflicts reported every booking as clashing — with its own room.
//
// The route predates probook booking rooms itself (v1.195). A read-only run on 22 Nov: checked 7,
// conflicts 7, every `conflictsWith` was the booking's own `[PB-<code>]` slot at the exact same time.
// findRoomConflict now skips the checked booking's own marker, and the route picks bookings with
// roomEligibleWhere() (the booker's rule — it had a hand-written REQUESTED/CONFIRMED list without ASSIGNED).
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'

const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000)
const shootDate = new Date(Date.UTC(inTwoWeeks.getUTCFullYear(), inTwoWeeks.getUTCMonth(), inTwoWeeks.getUTCDate()))
const ymd = shootDate.toISOString().slice(0, 10)
const slot = (title: string) => ({ startAt: `${ymd}T02:00:00.000Z`, endAt: `${ymd}T05:00:00.000Z`, title })

let where: any = null
const rows = [
  { id: 'a', bookingCode: 'AGN-OWN-01', locationId: 'tsd-studio-1', locationName: 'Studio 1 (TSD)',
    shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00' },
  { id: 'b', bookingCode: 'AGN-CLASH-01', locationId: 'tsd-studio-2', locationName: 'Studio 2 (TSD, 1/F)',
    shootDate, shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00' },
]
mock.module('../db', {
  namedExports: { prisma: { booking: { findMany: async (args: any) => { where = args.where; return rows } } } },
})
mock.module('../session', { namedExports: { getSession: async () => null } })

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url))
  if (u.pathname !== '/api/liff/room-slots') throw new Error(`unexpected fetch ${u}`)
  // Studio 1 (15): only our own booking for AGN-OWN-01 · Studio 2 (1): someone else's meeting
  const body = u.searchParams.get('roomId') === '15'
    ? [slot('[PB-AGN-OWN-01] AGN · Show')]
    : [slot('ประชุมแผนก')]
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as any

let GET: (r: any) => Promise<Response>
const savedSecret = process.env.REMINDERS_SECRET
before(async () => {
  process.env.REMINDERS_SECRET = 'rc-test-secret'
  ;({ GET } = await import('../../app/api/internal/room-conflicts/route'))
})
after(() => {
  globalThis.fetch = realFetch
  if (savedSecret === undefined) delete process.env.REMINDERS_SECRET; else process.env.REMINDERS_SECRET = savedSecret
})

test("a booking's own [PB-<code>] slot is not a conflict; someone else's is", async () => {
  const res = await GET(new Request('https://probook.test/api/internal/room-conflicts?days=30',
    { headers: { 'x-room-conflicts-secret': 'rc-test-secret' } }) as any)
  assert.equal(res.status, 200)
  const j: any = await res.json()
  assert.equal(j.checkedAgainstCentralSystem, 2)
  assert.deepEqual(j.conflicts.map((c: any) => c.code), ['AGN-CLASH-01'])
  assert.equal(j.conflicts[0].conflictsWith.title, 'ประชุมแผนก')
})

test('bookings are chosen with roomEligibleWhere (ASSIGNED included), not a hand-written status list', async () => {
  const { roomEligibleWhere } = await import('../room-booking-reconcile')
  assert.equal(where.status, undefined, 'no own status filter')
  assert.deepEqual(where.OR, roomEligibleWhere().OR)
  assert.equal(where.deletedAt, null)
})
