// maint 2026-11-08 R3 (calendar) — calendar-reconcile:
//  1. removeCancelledBookingEvent success leaves calendarSyncStatus alone (prod
//     parity: force-status CANCELLED→CONFIRMED brings the event back) and resets
//     it only when it is the helper's own FAILED marker
//  2. a failed retry of an edit's details patch no longer stops the tick: guests
//     are still compared/patched, the row goes back to FAILED + marker, and the
//     reconcile_failed audit row is written once per streak, not every 10 min
//  3. 'OK' is written with a CAS on the updatedAt read — a marker written by a
//     concurrent pushCalendarDetails survives
//  4. the time-drift alert is keyed by the drifting set (changed set = news,
//     same set = daily repeat)
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// one stateful booking row; updateMany honours every where-field it is given
let row: any
let audits: any[] = []
let alerts: any[] = []
let deleteOk = true
let detailsOk = true
let attendeeCalls: any[] = []
let event: any
let onEventRead: (() => void) | null = null

const matches = (where: any) => Object.entries(where).every(([k, v]) => {
  const cur = row[k]
  if (v instanceof Date) return cur instanceof Date && cur.getTime() === v.getTime()
  return cur === v
})
const write = (data: any) => { Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1000) }) }

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async ({ select }: any) => (select ? { calendarEventId: row.calendarEventId } : { ...row }),
        findMany: async ({ where }: any) => (where.calendarEventId ? [] : [{ ...row }]),
        update: async ({ data }: any) => { write(data); return { ...row } },
        updateMany: async ({ where, data }: any) => {
          if (!matches(where)) return { count: 0 }
          write(data)
          return { count: 1 }
        },
      },
      auditLog: {
        // newest matching row first, like orderBy at desc
        findFirst: async ({ where }: any) => {
          const acts: string[] = where.action?.in ?? [where.action]
          return [...audits].reverse().find(a => a.entityId === where.entityId && acts.includes(a.action)) ?? null
        },
      },
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
    createCalendarEvent: async () => 'ev-new',
    deleteCalendarEvent: async () => deleteOk,
    getCalendarEventAttendees: async () => { onEventRead?.(); return event },
    updateCalendarEventAttendees: async (id: string, emails: string[]) => { attendeeCalls.push({ id, emails }); return true },
    updateCalendarEventDetails: async () => detailsOk,
  },
})

let mod: typeof import('../calendar-reconcile')
let MARKER: string
before(async () => {
  mod = await import('../calendar-reconcile')
  // the exact text pushCalendarDetails writes
  row = { id: 'b1', bookingCode: 'X', calendarEventId: 'ev1', updatedAt: new Date('2026-11-01T00:00:00Z') }
  detailsOk = false
  await mod.pushCalendarDetails('ev1', row)
  MARKER = row.calendarSyncError
  assert.match(MARKER, /patch/)
})

beforeEach(() => {
  row = {
    id: 'b1', bookingCode: 'TSS-TSS-261120-01', status: 'CONFIRMED', deletedAt: null,
    shootDate: new Date('2026-11-20T00:00:00Z'), shootEndDate: null, callTime: '13:00', estimatedWrap: '18:00',
    shootType: 'STUDIO', producer: 'Pro', producerEmail: 'pro@x.co', coProducer: null, coProducerEmail: null,
    assignedEmails: ['crew@x.co'], crewRequired: [], calendarEventId: 'ev1',
    calendarSyncStatus: 'OK', calendarSyncError: null, calendarLastSyncedAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    outlet: { code: 'TSS', name: 'The Secret Sauce' }, program: { code: 'TSS', name: 'TSS' }, episodes: [],
  }
  event = { exists: true, attendees: ['crew@x.co', 'pro@x.co'], htmlLink: null, start: WANT.startTime, end: WANT.endTime }
  audits = []; alerts = []; attendeeCalls = []; deleteOk = true; detailsOk = true; onEventRead = null
})

// ── 1. removeCancelledBookingEvent ─────────────────────────────────────────
test('cancel delete OK: id + error cleared, calendarSyncStatus left as it was (prod parity)', async () => {
  row.status = 'CANCELLED'; row.calendarSyncStatus = 'OK'; row.calendarSyncError = 'stale'
  assert.equal(await mod.removeCancelledBookingEvent('b1', 'ev1'), true)
  assert.equal(row.calendarEventId, null)
  assert.equal(row.calendarSyncError, null)
  assert.equal(row.calendarSyncStatus, 'OK', 'force-status back to CONFIRMED must still make the reconciler recreate the event')
})

test('cancel delete OK after the helper\'s OWN failure: its FAILED marker is reset', async () => {
  row.status = 'CANCELLED'
  deleteOk = false
  assert.equal(await mod.removeCancelledBookingEvent('b1', 'ev1'), false)
  assert.equal(row.calendarSyncStatus, 'FAILED')
  assert.equal(row.calendarEventId, 'ev1')
  deleteOk = true
  assert.equal(await mod.removeCancelledBookingEvent('b1', 'ev1'), true)
  assert.equal(row.calendarSyncStatus, null)
  assert.equal(row.calendarSyncError, null)
  assert.equal(row.calendarEventId, null)
  assert.ok(row.calendarLastSyncedAt, 'lastSynced stays set → a later →CONFIRMED is still picked up, as in prod')
})

test('cancel delete OK but the id was re-pointed meanwhile: nothing is cleared', async () => {
  row.calendarEventId = 'ev-other'
  await mod.removeCancelledBookingEvent('b1', 'ev1')
  assert.equal(row.calendarEventId, 'ev-other')
})

// ── 2. failed details retry keeps syncing guests ───────────────────────────
test('details retry fails: guests are STILL patched, row back to FAILED + marker, item failed', async () => {
  row.calendarSyncStatus = 'FAILED'; row.calendarSyncError = MARKER
  detailsOk = false
  event.attendees = ['crew@x.co'] // producer missing on the event
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(attendeeCalls.length, 1, 'a details failure must not lock the booking out of guest sync')
  assert.deepEqual(attendeeCalls[0].emails, ['crew@x.co', 'pro@x.co'])
  assert.equal(r!.action, 'failed')
  assert.equal(r!.error, MARKER)
  assert.equal(row.calendarSyncStatus, 'FAILED')
  assert.equal(row.calendarSyncError, MARKER, 'the marker is what makes the next tick retry')
  assert.ok(audits.some(a => a.action === 'calendar.reconcile_patched'), 'the guest patch is still recorded')
})

test('details retry fails with guests in sync: FAILED + marker, never OK', async () => {
  row.calendarSyncStatus = 'FAILED'; row.calendarSyncError = MARKER
  detailsOk = false
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'failed')
  assert.equal(row.calendarSyncStatus, 'FAILED')
  assert.equal(row.calendarSyncError, MARKER)
})

test('a persistent details failure writes ONE reconcile_failed row per streak, not one per tick', async () => {
  row.calendarSyncStatus = 'FAILED'; row.calendarSyncError = MARKER
  detailsOk = false
  await mod.reconcileSingleBooking('b1')
  await mod.reconcileSingleBooking('b1')
  await mod.reconcileSingleBooking('b1')
  const failed = audits.filter(a => a.action === 'calendar.reconcile_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].changes.reason, 'details-retry-failed')

  // the retry lands, then a NEW edit fails again → a new streak = a new row
  detailsOk = true
  await mod.reconcileSingleBooking('b1')
  assert.equal(row.calendarSyncStatus, 'OK')
  assert.ok(audits.some(a => a.action === 'calendar.reconcile_details_patched'))
  row.calendarSyncStatus = 'FAILED'; row.calendarSyncError = MARKER
  detailsOk = false
  await mod.reconcileSingleBooking('b1')
  assert.equal(audits.filter(a => a.action === 'calendar.reconcile_failed').length, 2)
})

// ── 3. CAS on 'OK' ─────────────────────────────────────────────────────────
test('a FAILED marker written by a concurrent edit mid-tick is NOT overwritten with OK', async () => {
  // the edit's pushCalendarDetails fails while this tick is talking to Google
  onEventRead = () => {
    row.calendarSyncStatus = 'FAILED'; row.calendarSyncError = MARKER
    row.updatedAt = new Date(row.updatedAt.getTime() + 5000)
  }
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'ok')
  assert.equal(row.calendarSyncStatus, 'FAILED')
  assert.equal(row.calendarSyncError, MARKER, 'the next tick must still re-push the edit')
})

test('no concurrent write: OK is written as before', async () => {
  row.calendarSyncStatus = 'PENDING'
  const r = await mod.reconcileSingleBooking('b1')
  assert.equal(r!.action, 'ok')
  assert.equal(row.calendarSyncStatus, 'OK')
})

// ── 4. drift alert keyed by the set ────────────────────────────────────────
test('time-drift alert: key = fingerprint of the drifting set, same set repeats daily', async () => {
  event.start = '2026-11-20T09:00:00+07:00'
  await mod.reconcileCalendarGuests({})
  await mod.reconcileCalendarGuests({})
  assert.equal(alerts.length, 2) // alertOps (mocked here) owns the throttle
  assert.equal(alerts[0][0], alerts[1][0], 'same set → same key → alertOps throttles it')
  assert.match(alerts[0][0], /^calendar-time-drift:[0-9a-f]{16}$/)
  assert.equal(alerts[0][3], mod.DRIFT_SAME_SET_EVERY_MS)
  assert.ok(mod.DRIFT_SAME_SET_EVERY_MS > 6 * 3_600_000, 'longer than the default 6 h')

  event.start = '2026-11-20T08:00:00+07:00' // moved again = a different set
  await mod.reconcileCalendarGuests({})
  assert.notEqual(alerts[2][0], alerts[0][0], 'changed set → new key → alerted at once')
})

test('driftSetKey ignores order', () => {
  const d = (code: string, s: string) => ({ bookingId: code, bookingCode: code, timeDrift: { event: { start: s, end: 'e' }, booking: { start: 'b', end: 'e' } } })
  assert.equal(mod.driftSetKey([d('A', '1'), d('B', '2')]), mod.driftSetKey([d('B', '2'), d('A', '1')]))
  assert.notEqual(mod.driftSetKey([d('A', '1')]), mod.driftSetKey([d('A', '1'), d('B', '2')]))
})
