// Edits of an existing booking must reach the copies other people read:
//  - Bookings sheet cols H/I/K (Call Time / Wrap Time / Location) after a time or place edit,
//    from the admin PATCH and from producer-edit — a miss is logged + audited, not swallowed
//    (38 of 411 rows since 1 Oct kept the create-time values)
//  - the calendar event + _SHOOT marker after a producer fills in the QU (events kept
//    'QU-1234TBC'), without mailing guests for a QU-only change, and touching only the
//    description (a full patch moved a hand-moved event back to the DB times)
//  - a legacy Agency Ref that fails the QU rule no longer blocks an unrelated admin save
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any
let booking: any
let sheet: Array<{ code: string; fields: any }> = []
let sheetResult = 'updated'
let audits: any[] = []
let calendar: Array<{ id: string; opts: any }> = []
let markers: string[] = []

const merged = (a: any) => ({ ...booking, ...a.data })
mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findUnique: async () => booking && { ...booking }, update: async (a: any) => merged(a) },
      $transaction: async (fn: any) => fn({
        episode: { update: async () => ({}) },
        booking: { update: async (a: any) => merged(a), updateMany: async () => ({ count: 1 }) },
      }),
    },
  },
})
mock.module('../session', {
  namedExports: { getSession: async () => session, requireConsole: async () => session, requireAdmin: async () => session },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) }, diffBooking: () => null } })
mock.module('../google-sheets', {
  namedExports: {
    updateBookingRow: async (code: string, fields: any) => { sheet.push({ code, fields }); return sheetResult },
    joinEpisodeTitles: () => '',
  },
})
mock.module('../calendar-reconcile', {
  namedExports: {
    removeCancelledBookingEvent: async () => true,
    pushCalendarDetails: async (id: string, _b: any, opts?: any) => { calendar.push({ id, opts }); return true },
  },
})
mock.module('../ot-sync', { namedExports: { clearBookingOT: async () => 0, syncBookingOT: async () => ({ created: 0 }) } })
mock.module('../room-booking-sync', {
  namedExports: { releaseRoomForBooking: () => {}, resyncRoomForBooking: () => {}, roomScheduleChanges: () => [] },
})
mock.module('../crew-names', { namedExports: { resolveBookingCrew: async () => [] } })
mock.module('../shoot-marker', { namedExports: { refreshShootMarker: async (b: any) => { markers.push(b.id) } } })
mock.module('../google-drive', { namedExports: { hasDriveCredentials: () => true } })
mock.module('../email', { namedExports: { isEmailConfigured: () => false, sendEmail: async () => {} } })

let patch: any, producerEdit: any
before(async () => {
  ;({ PATCH: patch } = await import('../../app/api/bookings/[id]/route'))
  ;({ PATCH: producerEdit } = await import('../../app/api/bookings/[id]/producer-edit/route'))
})

const req = (body: any) => new Request('https://probook.test/x', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as any
const params = { params: { id: 'b1' } }
const tick = () => new Promise(r => setImmediate(r))
const schedWrites = () => sheet.filter(s => 'callTime' in s.fields)

beforeEach(() => {
  session = { email: 'admin@x.co', role: 'ADMIN' }
  booking = {
    id: 'b1', bookingCode: 'AGN-261124-01', status: 'CONFIRMED', deletedAt: null, calendarEventId: 'ev1', sheetRowIndex: 12,
    category: 'ADVERTORIAL', agencyRef: 'QU-1234TBC', callTime: '08:30', estimatedWrap: '12:00', locationName: 'Studio 1 (TSD)',
    createdByEmail: 'pro@x.co', producerEmail: 'pro@x.co', producer: 'Pro', shootDate: new Date('2026-11-24T00:00:00Z'),
    outlet: { code: 'AGN', name: 'Agency' }, program: { code: 'AGN', name: 'Agency' }, episodes: [],
  }
  sheet = []; sheetResult = 'updated'; audits = []; calendar = []; markers = []
})

test('admin PATCH: a call-time edit writes Call/Wrap/Location to the sheet row', async () => {
  const res = await patch(req({ callTime: '08:00' }), params)
  assert.equal(res.status, 200)
  await tick()
  assert.deepEqual(schedWrites(), [{ code: 'AGN-261124-01', fields: { callTime: '08:00', wrapTime: '12:00', location: 'Studio 1 (TSD)' } }])
})

test('admin PATCH: a location edit is pushed too; an edit that leaves time and place alone is not', async () => {
  await patch(req({ locationName: 'Studio 2 (TSD)' }), params)
  await tick()
  assert.equal(schedWrites().length, 1)
  assert.equal(schedWrites()[0].fields.location, 'Studio 2 (TSD)')
  sheet = []
  // same values resent (the admin form sends everything back) = nothing to push
  await patch(req({ callTime: '08:30', estimatedWrap: '12:00', locationName: 'Studio 1 (TSD)', notes: 'x' }), params)
  await tick()
  assert.equal(schedWrites().length, 0)
})

test('admin PATCH: a row the write could not reach is logged and audited, not swallowed', async () => {
  sheetResult = 'not-found'
  const errs: string[] = []
  const orig = console.error
  console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')) }
  try {
    await patch(req({ estimatedWrap: '13:00' }), params)
    await tick()
  } finally { console.error = orig }
  assert.ok(errs.some(e => e.includes('not-found') && e.includes('AGN-261124-01')), errs.join('\n'))
  const a = audits.find(x => x.action === 'booking.sheet_sync_failed')
  assert.ok(a, 'audit row written')
  assert.equal(a.changes.result, 'not-found')
})

test('admin PATCH: a legacy Agency Ref resent unchanged does not block the save (prod: 6 COMPLETED bookings)', async () => {
  booking.status = 'COMPLETED'; booking.agencyRef = 'รอ AE แจ้งค่ะ'
  const res = await patch(req({ agencyRef: 'รอ AE แจ้งค่ะ', notes: 'fix typo' }), params)
  assert.equal(res.status, 200)
  // changing it still goes through the rule
  const bad = await patch(req({ agencyRef: 'LIFE2601' }), params)
  assert.equal(bad.status, 400)
})

test('producer-edit on a COMPLETED booking: filling the QU re-pushes the event silently + refreshes the marker', async () => {
  booking.status = 'COMPLETED'
  session = { email: 'pro@x.co', role: 'USER' }
  const res = await producerEdit(req({ agencyRef: 'QU-3416' }), params)
  assert.equal(res.status, 200)
  await tick()
  assert.deepEqual(calendar, [{ id: 'ev1', opts: { sendUpdates: 'none', descriptionOnly: true } }])
  assert.deepEqual(markers, ['b1'])
  assert.equal(schedWrites().length, 0, 'no time/place change → no Call/Wrap/Location write')
})

test('producer-edit on a CONFIRMED booking: a location change keeps the default (guests told) and reaches the sheet', async () => {
  session = { email: 'pro@x.co', role: 'USER' }
  const res = await producerEdit(req({ locationName: 'Studio 2 (TSD)' }), params)
  assert.equal(res.status, 200)
  await tick()
  assert.deepEqual(calendar, [{ id: 'ev1', opts: undefined }])
  assert.deepEqual(schedWrites(), [{ code: 'AGN-261124-01', fields: { callTime: '08:30', wrapTime: '12:00', location: 'Studio 2 (TSD)' } }])
})

test('producer-edit on a REQUESTED booking: a time edit reaches the sheet; the QU alone does not push a calendar event', async () => {
  booking.status = 'REQUESTED'
  session = { email: 'pro@x.co', role: 'USER' }
  await producerEdit(req({ callTime: '09:00' }), params)
  await tick()
  assert.deepEqual(schedWrites().map(s => s.fields.callTime), ['09:00'])
  calendar = []
  await producerEdit(req({ agencyRef: 'QU-4500' }), params)
  await tick()
  assert.deepEqual(calendar, [], 'REQUESTED: no event or marker yet (prod behaviour kept)')
})
