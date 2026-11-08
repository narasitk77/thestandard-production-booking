// 2026-11-08 maintenance round 2 — internal routes accept ANY configured secret.
//
// Five worker routes still checked `X_SECRET || NEXTAUTH_SECRET || AUTH_SECRET`
// with `===`: the day the stack sets X_SECRET, every caller still sending
// NEXTAUTH_SECRET (Hermes jobs, manual curl, a worker container without X) gets
// 401. internalSecretAllowed (v1.123) matches against the whole set instead.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'

const SENTINEL = 'passed-auth'
const boom = async () => { throw new Error(SENTINEL) }

mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../heartbeat', {
  namedExports: { recordHeartbeat: async () => {}, maybeAlertStaleWorkers: async () => {} },
})
mock.module('../ops-alert', { namedExports: { alertOps: async () => ({ attempted: true, delivered: true }) } })
mock.module('../email', { namedExports: { sendEmail: async () => ({}) } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../backup', { namedExports: { runBackup: boom } })
mock.module('../reminders', { namedExports: { runReminderScan: boom } })
mock.module('../calendar-reconcile', { namedExports: { reconcileCalendarGuests: boom } })
mock.module('../folder-integrity', { namedExports: { runFolderIntegrity: boom, maybeSendDailyDigest: async () => {} } })
mock.module('../shoot-marker-reconcile', {
  namedExports: {
    reconcileShootMarkers: boom, reconcileGenericMarkers: boom, mergeReconcileResults: () => ({}),
    formatReconcileReport: () => '', totalChanges: () => 0,
  },
})

// [route, own secret env, header the worker sends]
const ROUTES: [string, string, string][] = [
  ['backup/run', 'BACKUP_SECRET', 'x-backup-secret'],
  ['reminders/run', 'REMINDERS_SECRET', 'x-reminders-secret'],
  ['calendar/reconcile', 'CALENDAR_RECONCILE_SECRET', 'x-reconcile-secret'],
  ['folder-integrity/run', 'PREP_FOLDERS_SECRET', 'x-prep-folders-secret'],
  ['shoot-markers/reconcile', 'SHOOT_MARKER_RECONCILE_SECRET', 'x-reconcile-secret'],
]
const ENV = ['NEXTAUTH_SECRET', 'AUTH_SECRET', ...ROUTES.map(r => r[1])]
const saved: Record<string, string | undefined> = {}
before(() => {
  for (const k of ENV) saved[k] = process.env[k]
  process.env.NEXTAUTH_SECRET = 'nextauth-value'
  delete process.env.AUTH_SECRET
  for (const [, env] of ROUTES) process.env[env] = `${env}-value`
})
after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** 401 → 'unauthorized'; reached the mocked worker body → SENTINEL. A bare 500
 *  does NOT count: a route that dies before its auth gate (import/env broke) also
 *  answers 500, and would pass every "authorised" case (round-3 review). */
async function outcome(path: string, headers: Record<string, string>): Promise<string> {
  const { GET } = await import(`../../app/api/internal/${path}/route`)
  const e = console.error
  console.error = () => {}
  try {
    const res: Response = await GET(new Request(`https://probook.test/api/internal/${path}`, { headers }) as any)
    if (res.status === 401) return 'unauthorized'
    const body = await res.text()
    return body.includes(SENTINEL) ? SENTINEL : `status ${res.status}: ${body.slice(0, 200)}`
  } catch (err: any) {
    if (err?.message === SENTINEL) return SENTINEL
    throw err
  } finally {
    console.error = e
  }
}

for (const [path, env, header] of ROUTES) {
  test(`${path}: ${env} set, caller sends NEXTAUTH_SECRET → still authorised`, async () => {
    assert.equal(await outcome(path, { [header]: 'nextauth-value' }), SENTINEL)
  })
  test(`${path}: caller sends ${env} → authorised`, async () => {
    assert.equal(await outcome(path, { [header]: `${env}-value` }), SENTINEL)
  })
  test(`${path}: bearer form still works`, async () => {
    assert.equal(await outcome(path, { authorization: `Bearer ${env}-value` }), SENTINEL)
  })
  test(`${path}: wrong secret → 401`, async () => {
    assert.equal(await outcome(path, { [header]: 'not-a-secret' }), 'unauthorized')
  })
}

test('folder-integrity/run: x-reconcile-secret header (what its worker sends) still accepted', async () => {
  assert.equal(await outcome('folder-integrity/run', { 'x-reconcile-secret': 'nextauth-value' }), SENTINEL)
})
