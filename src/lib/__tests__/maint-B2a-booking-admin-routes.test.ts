// maint 2026-11-08 (B2a) — status-changing paths:
//  - cancel (PATCH / DELETE / MCP) keeps calendarEventId when Google did not
//    confirm the delete (removeCancelledBookingEvent decides). R3: MCP may cancel
//    a COMPLETED booking again (prod), with a warning in the reply
//  - force-status does NOT write the sheet Status column (prod parity, Nat's decision pending); a forced CONFIRMED is picked up by the
//    reconciler (stale PENDING, not the NULL trap). R2: a CANCELLED booking is
//    still accepted (prod behaviour) but loudly — warning + no calendar/OT side effects
//  - add-episodes writes Episode IDs/Titles to the sheet; on cancelled/deleted rows it still adds (prod) but warns
//  - auto-complete flips COMPLETED in the DB only — the sheet Status column keeps
//    CONFIRMED (prod; PMDC's Airtable sync reads it, COMPLETED is Nat's decision)
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any
let booking: any
let updateManys: any[] = []
let updates: any[] = []
let sheet: Array<{ code: string; fields: any }> = []
let removed: Array<[string, string]> = []
let otCleared: string[] = []
let otSynced: string[] = []
let confirmedRows: any[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => booking && { ...booking },
        findFirst: async () => booking && { ...booking },
        findMany: async () => confirmedRows,
        update: async (a: any) => { updates.push(a); return { ...booking, ...a.data } },
        updateMany: async (a: any) => {
          updateManys.push(a)
          return { count: a.where.status && booking && a.where.status !== booking.status ? 0 : 1 }
        },
      },
      episode: { findMany: async () => [], create: async () => ({}) },
      $transaction: async (fn: any) => fn({
        episode: { findMany: async () => [], create: async () => ({}) },
        booking: {
          updateMany: async (a: any) => { updateManys.push(a); Object.assign(booking, a.data); return { count: 1 } },
          update: async (a: any) => { updates.push(a); return { ...booking, ...a.data } },
        },
      }),
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => session,
    requireConsole: async () => session,
    requireAdmin: async () => session,
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {}, diffBooking: () => null } })
mock.module('../google-sheets', {
  namedExports: {
    updateBookingRow: async (code: string, fields: any) => { sheet.push({ code, fields }); return 'updated' },
    joinEpisodeTitles: (eps: any[]) => eps.map(e => e.title).join(' | '),
  },
})
mock.module('../calendar-reconcile', {
  namedExports: {
    removeCancelledBookingEvent: async (id: string, ev: string) => { removed.push([id, ev]); return false },
    pushCalendarDetails: async () => true,
  },
})
mock.module('../ot-sync', {
  namedExports: {
    clearBookingOT: async (id: string) => { otCleared.push(id); return 0 },
    syncBookingOT: async (id: string) => { otSynced.push(id); return { created: 0 } },
  },
})
mock.module('../room-booking-sync', {
  namedExports: { releaseRoomForBooking: () => {}, resyncRoomForBooking: () => {}, roomScheduleChanges: () => [] },
})
mock.module('../crew-names', { namedExports: { resolveBookingCrew: async () => [] } })
mock.module('../shoot-marker', { namedExports: { refreshShootMarker: async () => {} } })
mock.module('../google-drive', { namedExports: { hasDriveCredentials: () => false } })
mock.module('../dashboard-episodes', {
  namedExports: { listProjectEpisodes: async () => ({ ok: true, episodes: [{ episodeId: 'PP-26-001-EP02', ep: 'EP.2', projectName: 'Shark' }] }) },
})
mock.module('../projects', { namedExports: { listProjects: async () => [] } })
mock.module('../create-booking', { namedExports: { createBookingFromPayload: async () => ({ ok: false, error: 'n/a' }) } })

let patch: any, del: any, force: any, addEps: any, autoComplete: any, tools: any
before(async () => {
  ;({ PATCH: patch, DELETE: del } = await import('../../app/api/bookings/[id]/route'))
  force = (await import('../../app/api/admin/[id]/force-status/route')).POST
  addEps = (await import('../../app/api/admin/[id]/add-episodes/route')).POST
  ;({ autoCompleteBookings: autoComplete } = await import('../booking-complete'))
  tools = (await import('../mcp/tools')).buildMcpRegistry()
})

const req = (body: any) => new Request('https://probook.test/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any
const params = { params: { id: 'b1' } }
const tick = () => new Promise(r => setImmediate(r))

beforeEach(() => {
  session = { email: 'admin@x.co', role: 'ADMIN' }
  booking = {
    id: 'b1', bookingCode: 'AGN-261101-01', status: 'CONFIRMED', deletedAt: null, calendarEventId: 'ev1', sheetRowIndex: null,
    approvedAt: new Date(), cancelReason: null, createdByEmail: 'pro@x.co', outlet: { code: 'AGN', name: 'Agency' },
    projectId: 'PP-26-001', programId: 'p1', program: { code: 'AGN', name: 'Agency' }, episodes: [{ episodeId: 'PP-26-001-EP01', sequence: 1, title: 'one' }],
    category: 'ADVERTORIAL',
  }
  updateManys = []; updates = []; sheet = []; removed = []; otCleared = []; otSynced = []; confirmedRows = []
})

test('PATCH cancel: the event id goes through removeCancelledBookingEvent, not a blind null', async () => {
  const res = await patch(req({ status: 'CANCELLED' }), params)
  assert.equal(res.status, 200)
  assert.deepEqual(removed, [['b1', 'ev1']])
  assert.ok(!updates.some(u => u.data && 'calendarEventId' in u.data && u.data.calendarEventId === null),
    'the route itself must not null the id — the helper does, only on a confirmed delete')
  assert.ok(sheet.some(s => s.fields.status === 'CANCELLED'), 'sheet written even with sheetRowIndex null')
})

test('DELETE: status flips, event id is NOT cleared in the same write', async () => {
  session = { email: 'pro@x.co', role: 'USER' }
  const res = await del(req({}), params)
  assert.equal(res.status, 200)
  const cas = updateManys.find(u => u.data.status === 'CANCELLED')
  assert.equal('calendarEventId' in cas.data, false)
  assert.deepEqual(removed, [['b1', 'ev1']])
})

test('PATCH → CONFIRMED (approve bypass) leaves a stale PENDING the reconciler picks up', async () => {
  booking.status = 'ASSIGNED'; booking.approvedAt = null; booking.calendarEventId = null
  booking.shootDate = new Date(Date.now() + 7 * 86_400_000); booking.shootEndDate = null // R3: only today-or-later shoots are armed
  const res = await patch(req({ status: 'CONFIRMED' }), params)
  assert.equal(res.status, 200)
  const cas = updateManys.find(u => u.data.status === 'CONFIRMED')
  assert.equal(cas.data.calendarSyncStatus, 'PENDING')
  assert.equal(cas.data.calendarLastSyncedAt.getTime(), 0)
  await tick()
  assert.ok(!sheet.some(s => 'status' in s.fields), 'prod parity: only CANCELLED reaches the sheet Status column (Nat decides the rest)')
})

// R3: prod behaviour restored — MCP may cancel a COMPLETED booking (the web
// refuses; refusing here too is Nat's decision), but the reply says so loudly.
// Signed OT in closed months is kept by clearBookingOT itself (ot-sync tests).
test('MCP cancel_booking: COMPLETED is still cancelled (prod), with a warning', async () => {
  booking.status = 'COMPLETED'
  const r = await tools.handlers.cancel_booking({ code: 'AGN-261101-01' })
  assert.equal(r.cancelled, true)
  assert.equal(r.previousStatus, 'COMPLETED')
  assert.match(r.warning, /was COMPLETED/)
  assert.deepEqual(updateManys[0].where, { id: 'b1', status: 'COMPLETED', deletedAt: null }, 'CAS on the status read')
  assert.deepEqual(otCleared, ['b1'])
})

test('MCP cancel_booking: CAS + event helper + sheet, and a failed event delete is reported', async () => {
  const r = await tools.handlers.cancel_booking({ code: 'AGN-261101-01' })
  assert.equal(r.cancelled, true)
  assert.deepEqual(updateManys[0].where, { id: 'b1', status: 'CONFIRMED', deletedAt: null })
  assert.deepEqual(removed, [['b1', 'ev1']])
  assert.match(r.warning, /could NOT be deleted/)
  assert.ok(sheet.some(s => s.fields.status === 'CANCELLED'))
})

test('force-status: CANCELLED is still accepted, but says what it did NOT do', async () => {
  booking.status = 'CANCELLED'; booking.calendarEventId = null; booking.calendarSyncStatus = null
  const res = await force(req({ status: 'COMPLETED' }), params)
  assert.equal(res.status, 200, 'prod behaviour kept — e.g. a shoot that happened after a mistaken cancel')
  const body = await res.json()
  assert.match(body.warning, /ปฏิทิน/)
  assert.match(body.warning, /OT/)
  assert.match(body.warning, /ห้อง/)
  await tick()
  assert.ok(!sheet.some(s => 'status' in s.fields), 'no sheet Status write from force-status (prod parity)')
})

test('force-status: CANCELLED → CONFIRMED does not arm the reconciler or rebuild OT', async () => {
  booking.status = 'CANCELLED'; booking.calendarEventId = null; booking.calendarSyncStatus = null
  const res = await force(req({ status: 'CONFIRMED' }), params)
  assert.equal(res.status, 200)
  assert.ok((await res.json()).warning)
  assert.equal('calendarSyncStatus' in updateManys[0].data, false, 'no stale PENDING → no surprise event + invites')
  await tick()
  assert.deepEqual(otSynced, [])
  assert.ok(!sheet.some(s => 'status' in s.fields), 'no sheet Status write from force-status (prod parity)')
})

test('force-status → CONFIRMED: stale PENDING + OT drafts, like approve (no sheet Status write)', async () => {
  booking.status = 'REQUESTED'
  booking.shootDate = new Date(Date.now() + 7 * 86_400_000); booking.shootEndDate = null // R3: only today-or-later shoots are armed
  const res = await force(req({ status: 'CONFIRMED' }), params)
  assert.equal(res.status, 200)
  assert.equal(updateManys[0].data.calendarSyncStatus, 'PENDING')
  assert.equal(updateManys[0].data.calendarLastSyncedAt.getTime(), 0)
  await tick()
  assert.ok(!sheet.some(s => 'status' in s.fields), 'no sheet Status write from force-status (prod parity)')
  assert.deepEqual(otSynced, ['b1'])
})

test('force-status → COMPLETED: no sheet Status write (PMDC reads it — Nat decides), OT left alone', async () => {
  const res = await force(req({ status: 'COMPLETED' }), params)
  assert.equal(res.status, 200)
  await tick()
  assert.ok(!sheet.some(s => 'status' in s.fields))
  assert.deepEqual(otSynced, [])
})

test('add-episodes: cancelled / deleted bookings still accepted (prod) but with a warning', async () => {
  booking.status = 'CANCELLED'
  let res = await addEps(req({ episodeIds: ['PP-26-001-EP02'] }), params)
  assert.equal(res.status, 200)
  assert.match((await res.json()).warning, /ยกเลิก/)
  booking.status = 'CONFIRMED'; booking.deletedAt = new Date()
  res = await addEps(req({ episodeIds: ['PP-26-001-EP02'] }), params)
  assert.equal(res.status, 200)
  assert.match((await res.json()).warning, /ลบ/)
})

test('add-episodes: sheet Episode IDs + Titles follow the added EP', async () => {
  const res = await addEps(req({ episodeIds: ['PP-26-001-EP02'] }), params)
  assert.equal(res.status, 200)
  await tick()
  const w = sheet.find(s => 'episodeIds' in s.fields)
  assert.ok(w, 'remove-episodes writes these columns; add must too')
  assert.equal(w!.code, 'AGN-261101-01')
})

test('auto-complete: an overnight shoot is not closed on its own morning; a finished one is flipped, sheet untouched', async () => {
  const bkk = new Date(Date.now() + 7 * 3_600_000)
  const today = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate())) // Bangkok "today"
  const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000)
  confirmedRows = [
    { id: 'done', bookingCode: 'TSS-1', shootDate: twoDaysAgo, shootEndDate: null, estimatedWrap: '18:00', callTime: '09:00' },
    // tonight 20:00 → 02:00 tomorrow: the old rule closed it any time after 02:00 today
    { id: 'night', bookingCode: 'TSS-2', shootDate: today, shootEndDate: today, estimatedWrap: '02:00', callTime: '20:00' },
  ]
  booking = null
  const n = await autoComplete()
  assert.equal(n, 1)
  assert.deepEqual(updateManys.map(u => u.where.id), ['done'], 'only the finished shoot is flipped')
  assert.ok(updateManys.every(u => u.where.status === 'CONFIRMED' && u.where.deletedAt === null), 'CAS: never resurrect a cancelled / deleted row')
  await tick(); await tick()
  assert.deepEqual(sheet, [], 'the sheet Status column keeps CONFIRMED (prod) until Nat decides')
})
