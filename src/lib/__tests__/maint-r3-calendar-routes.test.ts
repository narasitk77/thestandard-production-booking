// maint 2026-11-08 R3 (calendar) — status routes vs the reconciler:
//  - force-status out of CANCELLED tells the truth: a row that ever synced
//    (calendarSyncStatus OR calendarLastSyncedAt set) WILL get a new event +
//    invites from the reconciler; only a never-synced row will not
//  - PATCH / force-status →CONFIRMED arm the reconciler (stale PENDING → event +
//    invites) only for a shoot whose last day is today or later; a past shoot
//    keeps prod behaviour (sync fields untouched)
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let booking: any
let updateManys: any[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => booking && { ...booking },
        findFirst: async () => booking && { ...booking },
        update: async (a: any) => ({ ...booking, ...a.data }),
        updateMany: async (a: any) => { updateManys.push(a); return { count: 1 } },
      },
      episode: { findMany: async () => [], create: async () => ({}) },
      $transaction: async (fn: any) => fn({
        episode: { findMany: async () => [], create: async () => ({}) },
        booking: {
          updateMany: async (a: any) => { updateManys.push(a); Object.assign(booking, a.data); return { count: 1 } },
          update: async (a: any) => ({ ...booking, ...a.data }),
        },
      }),
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => ({ email: 'admin@x.co', role: 'ADMIN' }),
    requireConsole: async () => ({ email: 'admin@x.co', role: 'ADMIN' }),
    requireAdmin: async () => ({ email: 'admin@x.co', role: 'ADMIN' }),
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {}, diffBooking: () => null } })
mock.module('../google-sheets', {
  namedExports: { updateBookingRow: async () => 'updated', joinEpisodeTitles: () => '' },
})
mock.module('../calendar-reconcile', {
  namedExports: { removeCancelledBookingEvent: async () => true, pushCalendarDetails: async () => true },
})
mock.module('../ot-sync', { namedExports: { clearBookingOT: async () => 0, syncBookingOT: async () => ({ created: 0 }) } })
mock.module('../room-booking-sync', {
  namedExports: { releaseRoomForBooking: () => {}, resyncRoomForBooking: () => {}, roomScheduleChanges: () => [] },
})
mock.module('../crew-names', { namedExports: { resolveBookingCrew: async () => [] } })
mock.module('../shoot-marker', { namedExports: { refreshShootMarker: async () => {} } })
mock.module('../google-drive', { namedExports: { hasDriveCredentials: () => false } })

let patch: any, force: any
before(async () => {
  ;({ PATCH: patch } = await import('../../app/api/bookings/[id]/route'))
  force = (await import('../../app/api/admin/[id]/force-status/route')).POST
})

const req = (body: any) => new Request('https://probook.test/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any
const params = { params: { id: 'b1' } }
const DAY = 86_400_000
const bkkToday = () => {
  const bkk = new Date(Date.now() + 7 * 3_600_000)
  return new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))
}

beforeEach(() => {
  booking = {
    id: 'b1', bookingCode: 'AGN-261101-01', status: 'ASSIGNED', deletedAt: null, calendarEventId: null, sheetRowIndex: null,
    calendarSyncStatus: null, calendarLastSyncedAt: null,
    shootDate: new Date(bkkToday().getTime() + 3 * DAY), shootEndDate: null, callTime: '09:00', estimatedWrap: '18:00',
    approvedAt: null, cancelReason: null, createdByEmail: 'pro@x.co', outlet: { code: 'AGN', name: 'Agency' },
    projectId: 'PP-26-001', programId: 'p1', program: { code: 'AGN', name: 'Agency' }, episodes: [], category: 'ADVERTORIAL',
  }
  updateManys = []
})

// ── force-status warning ───────────────────────────────────────────────────
test('force CANCELLED→CONFIRMED, row synced before (lastSynced set, status NULL): says the reconciler WILL create + invite', async () => {
  booking.status = 'CANCELLED'; booking.calendarLastSyncedAt = new Date('2026-10-01T00:00:00Z')
  const body = await (await force(req({ status: 'CONFIRMED' }), params)).json()
  assert.match(body.warning, /reconciler จะสร้าง event ใหม่ \+ ส่ง invite/)
  assert.doesNotMatch(body.warning, /จะไม่สร้างให้/)
})

test('force CANCELLED→CONFIRMED, status still OK (cancel kept it, prod): WILL create + invite', async () => {
  booking.status = 'CANCELLED'; booking.calendarSyncStatus = 'OK'
  const body = await (await force(req({ status: 'CONFIRMED' }), params)).json()
  assert.match(body.warning, /reconciler จะสร้าง event ใหม่ \+ ส่ง invite/)
})

test('force CANCELLED→CONFIRMED, never synced (both NULL): says it will NOT, and how to get one', async () => {
  booking.status = 'CANCELLED'
  const body = await (await force(req({ status: 'CONFIRMED' }), params)).json()
  assert.match(body.warning, /reconciler จะไม่สร้างให้/)
  assert.match(body.warning, /Re-sync calendar/)
})

// ── today-or-later limit ───────────────────────────────────────────────────
test('force →CONFIRMED of a PAST shoot: sync fields untouched (prod), no invites to a gone date', async () => {
  booking.status = 'COMPLETED'; booking.shootDate = new Date(bkkToday().getTime() - 5 * DAY)
  assert.equal((await force(req({ status: 'CONFIRMED' }), params)).status, 200)
  assert.equal('calendarSyncStatus' in updateManys[0].data, false)
  assert.equal('calendarLastSyncedAt' in updateManys[0].data, false)
})

test('force →CONFIRMED of a shoot TODAY: armed (stale PENDING)', async () => {
  booking.status = 'REQUESTED'; booking.shootDate = bkkToday()
  await force(req({ status: 'CONFIRMED' }), params)
  assert.equal(updateManys[0].data.calendarSyncStatus, 'PENDING')
})

test('PATCH →CONFIRMED of a PAST shoot: sync fields untouched (prod)', async () => {
  booking.shootDate = new Date(bkkToday().getTime() - 2 * DAY)
  assert.equal((await patch(req({ status: 'CONFIRMED' }), params)).status, 200)
  const cas = updateManys.find(u => u.data.status === 'CONFIRMED')
  assert.equal('calendarSyncStatus' in cas.data, false)
})

test('PATCH →CONFIRMED of a future shoot: armed (stale PENDING)', async () => {
  assert.equal((await patch(req({ status: 'CONFIRMED' }), params)).status, 200)
  const cas = updateManys.find(u => u.data.status === 'CONFIRMED')
  assert.equal(cas.data.calendarSyncStatus, 'PENDING')
  assert.equal(cas.data.calendarLastSyncedAt.getTime(), 0)
})

test('PATCH →CONFIRMED of a multi-day shoot still running (started yesterday, ends tomorrow): armed', async () => {
  booking.shootDate = new Date(bkkToday().getTime() - DAY); booking.shootEndDate = new Date(bkkToday().getTime() + DAY)
  await patch(req({ status: 'CONFIRMED' }), params)
  const cas = updateManys.find(u => u.data.status === 'CONFIRMED')
  assert.equal(cas.data.calendarSyncStatus, 'PENDING')
})
