// 2026-11-08 maintenance — /api/internal/calendar/reconcile
//
// (1) The dead-man check for all 16 workers ran only AFTER a successful Calendar
//     pass, so a pass that threw (or hung on a Google socket) silenced the in-app
//     alarm for everything. It must run regardless of the pass.
// (2) result.truncated was printed to the console only (bug class 7: a flag nobody
//     reads). It must reach the heartbeat note and alertOps.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let reconcile: () => Promise<any> = async () => ({ checked: 1, truncated: false })
const deadman: string[] = []
const beats: { key: string; note?: string }[] = []
const alerts: string[] = []

mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../calendar-reconcile', { namedExports: { reconcileCalendarGuests: () => reconcile() } })
mock.module('../heartbeat', {
  namedExports: {
    recordHeartbeat: async (key: string, note?: string) => { beats.push({ key, note }) },
    maybeAlertStaleWorkers: async () => { deadman.push('ran') },
  },
})
mock.module('../ops-alert', {
  namedExports: { alertOps: async (key: string) => { alerts.push(key); return { attempted: true, delivered: true } } },
})

let GET: (r: any) => Promise<Response>
before(async () => {
  process.env.CALENDAR_RECONCILE_SECRET = 'cal-secret'
  ;({ GET } = await import('../../app/api/internal/calendar/reconcile/route'))
})
beforeEach(() => { deadman.length = 0; beats.length = 0; alerts.length = 0 })
const req = (qs = '') =>
  new Request(`https://probook.test/api/internal/calendar/reconcile?limit=200${qs}`, { headers: { 'x-reconcile-secret': 'cal-secret' } }) as any

const quietErrors = async <T>(fn: () => Promise<T>) => {
  const e = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = e }
}

test('Calendar pass throws → dead-man check for the other workers still runs', async () => {
  reconcile = async () => { throw new Error('Google Calendar 500') }
  const res = await quietErrors(() => GET(req()))
  assert.equal(res.status, 500)
  assert.deepEqual(deadman, ['ran'])
})

test('truncated pass → heartbeat note says so and ops is alerted', async () => {
  reconcile = async () => ({ checked: 200, ok: 200, patched: 0, created: 0, failed: 0, truncated: true, items: [] })
  const res = await GET(req())
  assert.equal(res.status, 200)
  assert.equal(beats[0].key, 'calendar-reconcile')
  assert.match(beats[0].note || '', /TRUNCATED checked=200/)
  assert.deepEqual(alerts, ['calendar-reconcile-truncated'])
})

test('normal pass → heartbeat without note, no alert, dead-man ran once', async () => {
  reconcile = async () => ({ checked: 12, ok: 12, patched: 0, created: 0, failed: 0, truncated: false, items: [] })
  await GET(req())
  assert.deepEqual(beats, [{ key: 'calendar-reconcile', note: undefined }])
  assert.equal(alerts.length, 0)
  assert.deepEqual(deadman, ['ran'])
})

test('dry run touches neither the heartbeat nor the dead-man', async () => {
  reconcile = async () => ({ checked: 200, truncated: true, items: [] })
  await GET(req('&dryRun=1'))
  assert.equal(beats.length + deadman.length + alerts.length, 0)
})
