// maint 2026-11-08 (B2a) — calendar-reconcile:
//  1. a cancelled booking's event is cleared ONLY when Google confirms the delete;
//     a failed delete keeps the id and the sweep retries + alerts ops
//     (it used to null the id anyway → the shoot stayed on every crew calendar)
//  2. the event's TIMES are checked, not just guests (a failed edit patch left
//     the event at the old time forever). R2: only a row an edit marked
//     DETAILS_PATCH_FAILED is re-pushed (sendUpdates 'all' — the crew were never
//     told); pure drift (hand move in Google Calendar) is REPORTED, not reverted
//  3. dryRun (/admin/<id> page load) writes no audit rows
//  4. create payloads carry the Co-Producer (guest + description line)
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let booking: any
let mainRows: any[] = []
let sweepRows: any[] = []
let updates: any[] = []
let audits: any[] = []
let alerts: any[] = []
let deleteOk = true
let detailsOk = true
let detailsCalls: any[] = []
let created: any[] = []
let event: any
let lastDriftAudit: any = null

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async ({ where, select }: any) => (select ? { calendarEventId: booking?.calendarEventId ?? null } : (where.id === booking?.id ? booking : null)),
        findMany: async ({ where }: any) => (where.calendarEventId ? sweepRows : mainRows),
        update: async (a: any) => { updates.push({ kind: 'update', ...a }); return {} },
        updateMany: async (a: any) => { updates.push({ kind: 'updateMany', ...a }); return { count: 1 } },
      },
      auditLog: { findFirst: async () => lastDriftAudit },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../ops-alert', { namedExports: { alertOps: async (...a: any[]) => { alerts.push(a); return { attempted: true, delivered: true } } } })
mock.module('../google-sheets', { namedExports: { updateBookingRow: async () => 'updated' } })
const WANT = { startTime: '2026-11-20T13:00:00+07:00', endTime: '2026-11-20T18:00:00+07:00' }
mock.module('../google-calendar', {
  namedExports: {
    computeEventTimes: () => WANT,
    createCalendarEvent: async (b: any) => { created.push(b); return 'ev-new' },
    deleteCalendarEvent: async () => deleteOk,
    getCalendarEventAttendees: async (id: string) => (id === 'ev-new'
      ? { exists: true, attendees: ['crew@x.co', 'pro@x.co', 'copro@x.co'], htmlLink: null }
      : event),
    updateCalendarEventAttendees: async () => true,
    updateCalendarEventDetails: async (id: string, b: any, opts: any) => { detailsCalls.push({ id, opts }); return detailsOk },
  },
})

let mod: typeof import('../calendar-reconcile')
before(async () => { mod = await import('../calendar-reconcile') })

beforeEach(() => {
  booking = {
    id: 'b1', bookingCode: 'TSS-TSS-261120-01', status: 'CONFIRMED', deletedAt: null,
    shootDate: new Date('2026-11-20T00:00:00Z'), shootEndDate: null, callTime: '13:00', estimatedWrap: '18:00',
    shootType: 'STUDIO', producer: 'Pro', producerEmail: 'pro@x.co', coProducer: 'Co', coProducerEmail: 'copro@x.co',
    assignedEmails: ['crew@x.co'], crewRequired: [], calendarEventId: 'ev1', calendarSyncStatus: 'OK',
    outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { code: 'TSS', name: 'TSS' }, episodes: [],
  }
  event = { exists: true, attendees: ['crew@x.co', 'pro@x.co', 'copro@x.co'], htmlLink: null, start: WANT.startTime, end: WANT.endTime }
  mainRows = []; sweepRows = []; updates = []; audits = []; alerts = []; detailsCalls = []; created = []
  deleteOk = true; detailsOk = true; lastDriftAudit = null
})

test('pure time drift (event moved by hand in Google) → reported, NOT reverted', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'ok', 'guests match; drift is a report, not a patch')
  assert.equal(detailsCalls.length, 0, 'never silently move a hand-edited event back')
  assert.deepEqual(r!.timeDrift, {
    event: { start: '2026-11-20T09:00:00+07:00', end: WANT.endTime },
    booking: { start: WANT.startTime, end: WANT.endTime },
  })
  const a = audits.find(x => x.action === 'calendar.reconcile_time_drift')
  assert.ok(a, 'drift leaves an audit row')
  assert.equal(a.changes.eventId, 'ev1')
})

test('same instant in another offset is NOT drift', async () => {
  event.start = '2026-11-20T06:00:00Z'
  event.end = '2026-11-20T11:00:00.000Z'
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'ok')
  assert.equal(detailsCalls.length, 0)
})

test('a FAILED row from an edit (DETAILS_PATCH_FAILED) is re-pushed with sendUpdates all', async () => {
  // what pushCalendarDetails writes when the edit's own patch failed
  detailsOk = false
  await mod.pushCalendarDetails('ev1', booking)
  const marker = updates.find(u => u.kind === 'updateMany').data.calendarSyncError
  updates = []; detailsCalls = []; detailsOk = true
  booking.calendarSyncStatus = 'FAILED'; booking.calendarSyncError = marker
  event.start = '2026-11-20T09:00:00+07:00' // still the old time
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(detailsCalls.length, 1)
  assert.deepEqual(detailsCalls[0].opts, { sendUpdates: 'all' }, 'the crew were never told about this edit')
  assert.equal(r!.action, 'patched')
  assert.equal(r!.timeDrift, undefined, 'a retried edit is not reported as drift')
  assert.ok(audits.some(a => a.action === 'calendar.reconcile_details_patched' && a.changes.reason === 'retry-after-failed-edit'))
  assert.ok(updates.some(u => u.data?.calendarSyncStatus === 'OK'), 'cleared once the patch landed')
})

test('retry of a failed edit fails again → FAILED with the SAME marker (next tick retries)', async () => {
  detailsOk = false
  await mod.pushCalendarDetails('ev1', booking)
  const marker = updates.find(u => u.kind === 'updateMany').data.calendarSyncError
  updates = []
  booking.calendarSyncStatus = 'FAILED'; booking.calendarSyncError = marker
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'failed')
  const u = updates.find(x => x.data?.calendarSyncStatus === 'FAILED')
  assert.equal(u.data.calendarSyncError, marker)
})

test('a row FAILED for another reason (attendee patch) is NOT re-pushed every tick', async () => {
  booking.calendarSyncStatus = 'FAILED'; booking.calendarSyncError = 'attendee patch failed: bad address'
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(detailsCalls.length, 0)
  assert.equal(r!.action, 'ok')
  assert.ok(!audits.some(a => a.action === 'calendar.reconcile_details_patched'))
})

test('dryRun: reports drift / guest mismatch but patches nothing and writes no audit row', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  event.attendees = ['crew@x.co']
  const r = await mod.reconcileSingleBooking('b1', { dryRun: true })
  assert.equal(r!.action, 'patched')
  assert.ok(r!.timeDrift, 'the drift is still in the report')
  assert.equal(detailsCalls.length, 0)
  assert.deepEqual(audits, [], 'a page view must not log "reconcile_patched"')
  assert.deepEqual(updates, [])
})

test('dryRun failure writes no reconcile_failed audit row either', async () => {
  booking.calendarEventId = 'ev1'
  event = Promise.reject(new Error('Google 500'))
  event.catch(() => {})
  const r = await mod.reconcileSingleBooking('b1', { dryRun: true })
  assert.equal(r!.action, 'failed')
  assert.deepEqual(audits, [])
})

test('create payload carries coProducer + coProducerEmail', async () => {
  booking.calendarEventId = null
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'created')
  assert.equal(created[0].coProducerEmail, 'copro@x.co')
  assert.equal(created[0].coProducer, 'Co', 'description line "Co-Producer:"')
})

test('removeCancelledBookingEvent: delete OK → id cleared (CAS on the same id)', async () => {
  assert.equal(await mod.removeCancelledBookingEvent('b1', 'ev1'), true)
  const u = updates.find(x => x.kind === 'updateMany')
  // R3: the first write also narrows to the helper's own FAILED marker (see below)
  assert.equal(u.where.id, 'b1')
  assert.equal(u.where.calendarEventId, 'ev1')
  assert.equal(u.data.calendarEventId, null)
})

test('removeCancelledBookingEvent: delete FAILED → id KEPT, row marked FAILED', async () => {
  deleteOk = false
  assert.equal(await mod.removeCancelledBookingEvent('b1', 'ev1'), false)
  const u = updates.find(x => x.kind === 'updateMany')
  assert.equal('calendarEventId' in u.data, false, 'never null the only pointer to a live event')
  assert.equal(u.data.calendarSyncStatus, 'FAILED')
})

test('sweep: cancelled rows still holding an event are retried; a failure alerts ops', async () => {
  sweepRows = [{ id: 'c1', bookingCode: 'AGN-261101-01', calendarEventId: 'evC', assignedEmails: [] }]
  deleteOk = false
  const r = await mod.reconcileCalendarGuests({})
  assert.deepEqual(r.cancelledEvents, { found: 1, deleted: 0, failed: 1 })
  assert.equal(r.failed, 1, 'worker log line fires')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0][2], /AGN-261101-01/)

  deleteOk = true; alerts = []
  const r2 = await mod.reconcileCalendarGuests({})
  assert.deepEqual(r2.cancelledEvents, { found: 1, deleted: 1, failed: 0 })
  assert.equal(alerts.length, 0)
})

test('sweep dryRun deletes nothing', async () => {
  sweepRows = [{ id: 'c1', bookingCode: 'X', calendarEventId: 'evC', assignedEmails: [] }]
  const r = await mod.reconcileCalendarGuests({ dryRun: true })
  assert.deepEqual(r.cancelledEvents, { found: 1, deleted: 0, failed: 0 })
  assert.deepEqual(updates, [])
})

test('pushCalendarDetails: a failed edit patch marks the booking FAILED (it used to vanish)', async () => {
  detailsOk = false
  assert.equal(await mod.pushCalendarDetails('ev1', booking), false)
  const u = updates.find(x => x.kind === 'updateMany')
  assert.equal(u.data.calendarSyncStatus, 'FAILED')
  assert.deepEqual(u.where, { id: 'b1', calendarEventId: 'ev1' })
})

// ── R2: drift is reported loudly but once, never patched ──────────────────
test('drift audit is deduped: the same drift already recorded → no second row', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  // jsonb hands keys back in its own order — compare field by field
  lastDriftAudit = { changes: { booking: { end: WANT.endTime, start: WANT.startTime }, event: { end: WANT.endTime, start: '2026-11-20T09:00:00+07:00' }, eventId: 'ev1' } }
  await mod.reconcileSingleBooking('b1')
  assert.ok(!audits.some(a => a.action === 'calendar.reconcile_time_drift'))
  lastDriftAudit.changes.event.start = '2026-11-20T08:00:00+07:00' // moved again
  await mod.reconcileSingleBooking('b1')
  assert.ok(audits.some(a => a.action === 'calendar.reconcile_time_drift'))
})

test('bulk tick: drifted jobs → ONE ops alert naming them; dryRun alerts nobody', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  mainRows = [booking]
  await mod.reconcileCalendarGuests({ dryRun: true })
  assert.equal(alerts.length, 0)
  const r = await mod.reconcileCalendarGuests({})
  assert.equal(detailsCalls.length, 0)
  assert.equal(alerts.length, 1)
  // R3: keyed by a fingerprint of the drifting set (same set = daily repeat, changed set = news)
  assert.match(alerts[0][0], /^calendar-time-drift:[0-9a-f]{16}$/)
  assert.match(alerts[0][2], /TSS-TSS-261120-01/)
  assert.ok(r.items[0].timeDrift)
})

test('a row saved < 5 min ago is not drift yet (its edit patch may be in flight)', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  booking.updatedAt = new Date(Date.now() - 60_000)
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.timeDrift, undefined)
  assert.ok(!audits.some(a => a.action === 'calendar.reconcile_time_drift'))
})

test('no start/end from Google = unknown, not drift', async () => {
  delete event.start; delete event.end
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.timeDrift, undefined)
})

// R3 (prod parity): success resets calendarSyncStatus ONLY when it is this
// helper's own FAILED marker — any other status stays, so force-status
// CANCELLED→CONFIRMED brings the event back as prod does. The "other status
// stays" half is in maint-r3-calendar-reconcile.test.ts (needs a CAS-aware mock).
test('removeCancelledBookingEvent success resets the status only on its own FAILED marker', async () => {
  await mod.removeCancelledBookingEvent('b1', 'ev1')
  const u = updates.find(x => x.kind === 'updateMany')
  assert.equal(u.where.calendarSyncStatus, 'FAILED')
  assert.match(u.where.calendarSyncError, /ลบ event ในปฏิทินไม่สำเร็จ/)
  assert.equal(u.data.calendarSyncStatus, null)
  assert.equal(u.data.calendarEventId, null)
})
