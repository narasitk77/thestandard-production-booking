// Maintenance 23 Nov 2026 — the hourly mix-calendar run re-patches every event in its window (by
// design: planMixCalendar can't know an event is already right). It also wrote an audit row and a
// mix_jobs update every hour for MIX-004 alone: 33% of audit_logs since 28 Sep, and updatedAt on the
// job bumped hourly so it meant nothing. A run that only re-patched healthy events writes neither;
// creates, deletes and failures are still audited, and a sync error is still cleared.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let rows: any[] = []
let jobUpdates: any[] = []
let audits: any[] = []
let alerts: any[] = []
let patchFails = false

mock.module('../db', {
  namedExports: {
    prisma: {
      mixJob: {
        findMany: async () => rows,
        findUnique: async ({ where }: any) => rows.find(r => r.id === where.id) ?? null,
        update: async (a: any) => { jobUpdates.push(a); return {} },
      },
    },
  },
})
mock.module('googleapis', {
  namedExports: {
    google: {
      calendar: () => ({
        calendars: { get: async () => ({ data: { summary: 'คิวมิกซ์' } }) },
        events: {
          patch: async () => { if (patchFails) throw Object.assign(new Error('Rate Limit Exceeded'), { code: 403 }); return {} },
          insert: async () => ({}),
          delete: async () => ({}),
        },
      }),
      auth: { JWT: class {} },
    },
  },
})
mock.module('../google-calendar', { namedExports: { bookingCalendarIds: () => ['shoots@group'], getCalendarAuth: () => ({}) } })
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async () => {} } })
mock.module('../ops-alert', { namedExports: { alertOps: async (...a: any[]) => { alerts.push(a); return { attempted: true, delivered: true } } } })

let GET: (r: any) => Promise<Response>
before(async () => {
  process.env.MIX_CALENDAR_ID = 'mix@group'
  process.env.NEXTAUTH_SECRET = 'mix-test-secret'
  ;({ GET } = await import('../../app/api/internal/mix-calendar/sync/route'))
})
beforeEach(() => { rows = []; jobUpdates = []; audits = []; alerts = []; patchFails = false })

const job = (over: any = {}) => ({
  id: 'job4', number: 4, title: 'Mix', status: 'QUEUED', dueDate: new Date(), deletedAt: null,
  requesterEmail: 'req@x.co', calendarEventId: 'mc6a6f6234', calendarSyncError: null, ...over,
})
const run = async () => {
  const res = await GET(new Request('https://probook.test/api/internal/mix-calendar/sync?dryRun=0',
    { headers: { 'x-reconcile-secret': 'mix-test-secret' } }) as any)
  return res.json()
}

test('update-only run on a healthy event → patched, but no audit row and no mix_jobs write', async () => {
  rows = [job()]
  const body = await run()
  assert.equal(body.ok, true)
  assert.deepEqual(body.counts, { create: 0, update: 1, delete: 0, none: 0 })
  assert.equal(audits.length, 0)
  assert.equal(jobUpdates.length, 0, 'unchanged event id + no error = nothing to write (updatedAt stays meaningful)')
})

test('update that clears an old sync error still writes the row (error → null), still no audit', async () => {
  rows = [job({ calendarSyncError: 'Rate Limit Exceeded' })]
  await run()
  assert.deepEqual(jobUpdates.map(u => u.data), [{ calendarEventId: 'mc6a6f6234', calendarSyncError: null }])
  assert.equal(audits.length, 0)
})

test('a create is audited and saves the event id', async () => {
  rows = [job({ calendarEventId: null })]
  await run()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'mix.calendar_sync')
  assert.equal(jobUpdates[0].data.calendarEventId?.startsWith('mc'), true)
})

test('a failed update is audited (and alerted)', async () => {
  rows = [job()]
  patchFails = true
  const e = console.error
  console.error = () => {}
  try { await run() } finally { console.error = e }
  assert.equal(audits.length, 1)
  assert.equal(audits[0].changes.failed, 1)
  assert.equal(alerts.length, 1)
})
