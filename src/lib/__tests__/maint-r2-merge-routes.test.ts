/**
 * maint 2026-11-08 round 2 (merge) — the routes' "one real run at a time" guard:
 *
 * - round 1 made it expire after 45 min, while a per-booking lock lives 2 h (MERGE_LOCK_MAX_MS) and the old boolean
 *   never let two passes overlap. A slow but LIVE pass at minute 46 was overlapped by the next hourly run. The guard
 *   now expires only at MERGE_LOCK_MAX_MS: hang recovery, never an overlap.
 * - footage/sync and landing-dedup/run still had the boolean (latched forever on one hung call) → runGuard too.
 * - footage/sync: the 'footage' dead-man heartbeat is ticked only by the worker's (secret) run that synced — not by an
 *   admin click, not by a run that stopped early with a `reason` (env unset / sheet probe / Drive list failed).
 */
import { test, mock, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MERGE_LOCK_MAX_MS } from '../merge-lock'

let session: any = null
const ticks: string[] = []
/** the FIRST real call of each runner waits on `gate` (a live, slow pass); later calls return at once */
let gate: Promise<void> | null = null
let release: () => void = () => {}
const calls: Record<string, number> = {}
const slow = async (name: string, dryRun: boolean | undefined, result: any) => {
  if (!dryRun && (calls[name] = (calls[name] ?? 0) + 1) === 1 && gate) await gate
  return result
}
let syncResult: any

mock.module('../session', { namedExports: { getSession: async () => session } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async (k: string) => { ticks.push(k) } } })
mock.module('../notify', { namedExports: { notifyChat: async () => true } })
mock.module('../audit', { namedExports: { logAudit: () => {} } })
mock.module('../video-merge', {
  namedExports: {
    runVideoMerge: (o: any) => slow('video', o?.dryRun, { skipped: false, dryRun: !!o?.dryRun, bookings: 1, landed: 0, moved: 0, movedFolders: 0, errors: 0, cardHolds: [], cardHoldsChatDue: false, results: [] }),
    rememberCardHoldsPosted: async () => {},
  },
})
mock.module('../sound-merge', { namedExports: { runSoundMerge: (o: any) => slow('sound', o?.dryRun, { skipped: false, bookings: 1, staged: 0, merged: 0, errors: 0, results: [] }) } })
mock.module('../prep-folders', { namedExports: { prepTodayShootFolders: (o: any) => slow('prep', o?.dryRun, { skipped: false, dryRun: false, total: 1, prepared: 1, errors: 0, prodTeamErrors: 0, results: [] }) } })
mock.module('../footage-sync', { namedExports: { runFootageSync: (o: any) => slow('sync', o?.dryRun, syncResult) } })
mock.module('../landing-dedup', { namedExports: { dedupeLandingFolders: (o: any) => slow('dedup', o?.dryRun, { trashed: 0, groupsWithDuplicates: 0, collisions: [], errors: 0 }) } })

type GET = (r: any) => Promise<Response>
const routes: Record<string, GET> = {}
before(async () => {
  process.env.VIDEO_MERGE_SECRET = 'vm-secret'
  process.env.SOUND_MERGE_SECRET = 'sm-secret'
  process.env.PREP_FOLDERS_SECRET = 'pf-secret'
  process.env.FOOTAGE_SYNC_SECRET = 'fs-secret'
  routes.video = (await import('../../app/api/internal/video-merge/run/route')).GET
  routes.sound = (await import('../../app/api/internal/sound-merge/run/route')).GET
  routes.prep = (await import('../../app/api/internal/prep-folders/run/route')).GET
  routes.sync = (await import('../../app/api/internal/footage/sync/route')).GET
  routes.dedup = (await import('../../app/api/internal/landing-dedup/run/route')).GET
})

const okSync = (over: any = {}) => ({ ok: true, scanned: 3, seen: 3, matched: 0, parsedNoBooking: 0, unparsed: 0, retried: 0, errors: [], ...over })
beforeEach(() => {
  session = null; gate = null; ticks.length = 0
  for (const k of Object.keys(calls)) delete calls[k]
  syncResult = okSync()
})
afterEach(() => { mock.timers.reset() })

/** a worker (secret) request for each route — dryRun=0 on landing-dedup, whose default is a dry run */
const req: Record<string, (qs?: string) => any> = {
  video: (qs = '') => new Request(`https://probook.test/api/internal/video-merge/run${qs}`, { headers: { 'x-video-merge-secret': 'vm-secret' } }),
  sound: (qs = '') => new Request(`https://probook.test/api/internal/sound-merge/run${qs}`, { headers: { 'x-sound-merge-secret': 'sm-secret' } }),
  prep: (qs = '') => new Request(`https://probook.test/api/internal/prep-folders/run${qs}`, { headers: { 'x-prep-folders-secret': 'pf-secret' } }),
  sync: (qs = '') => new Request(`https://probook.test/api/internal/footage/sync${qs}`, { headers: { 'x-footage-sync-secret': 'fs-secret' } }),
  dedup: (qs = '?dryRun=0') => new Request(`https://probook.test/api/internal/landing-dedup/run${qs}`, { headers: { 'x-reconcile-secret': 'pf-secret' } }),
}
const dryQs: Record<string, string> = { video: '?dryRun=1', sound: '?dryRun=1', prep: '?dryRun=1', sync: '?dryRun=1', dedup: '?dryRun=1' }

for (const name of ['video', 'sound', 'prep', 'sync', 'dedup']) {
  test(`${name}: a slow LIVE run is never overlapped — 409 at minute 46 and until MERGE_LOCK_MAX_MS; only then a hung run is taken over (loudly)`, async () => {
    const T = 1_800_000_000_000
    mock.timers.enable({ apis: ['Date'], now: T })
    gate = new Promise<void>(r => { release = r })
    const first = routes[name](req[name]())
    await new Promise(r => setImmediate(r))

    mock.timers.setTime(T + 46 * 60_000)
    assert.equal((await routes[name](req[name]())).status, 409, 'round 1: the 45-min guard let the next hourly pass overlap a live one')
    assert.equal((await routes[name](req[name](dryQs[name]))).status, 200, 'dryRun is never gated')
    mock.timers.setTime(T + MERGE_LOCK_MAX_MS - 1)
    assert.equal((await routes[name](req[name]())).status, 409)

    const errors = mock.method(console, 'error', () => {})
    try {
      mock.timers.setTime(T + MERGE_LOCK_MAX_MS)
      assert.equal((await routes[name](req[name]())).status, 200, 'a run older than MERGE_LOCK_MAX_MS is hung, not slow')
      assert.ok(errors.mock.calls.some(c => /ยังไม่จบ/.test(String(c.arguments[0]))), 'the takeover is logged as an error')
    } finally { errors.mock.restore() }

    release(); assert.equal((await first).status, 200) // the hung run finally returns (its stale end() frees nothing)
    mock.timers.setTime(T + MERGE_LOCK_MAX_MS + 1)
    assert.equal((await routes[name](req[name]())).status, 200, 'the next run starts normally')
  })
}

test('footage/sync: heartbeat only for the worker\'s real run that synced — not an admin click, not a run that stopped early', async () => {
  session = { role: 'ADMIN', email: 'nat@x.co' }
  assert.equal((await routes.sync(new Request('https://probook.test/api/internal/footage/sync'))).status, 200)
  assert.deepEqual(ticks, [], 'an admin click must not stand in for a dead worker')
  session = null

  await routes.sync(req.sync('?dryRun=1'))
  assert.deepEqual(ticks, [])

  syncResult = okSync({ ok: false, scanned: 0, reason: 'probeSheet failed: 403 The caller does not have permission' })
  const errors = mock.method(console, 'error', () => {})
  try {
    assert.equal((await routes.sync(req.sync())).status, 200)
    assert.deepEqual(ticks, [], 'pre-fix: a run that synced nothing ticked the dead-man')
    assert.ok(errors.mock.calls.some(c => /\[footage-sync\] run failed: probeSheet failed/.test(String(c.arguments[0]))))
  } finally { errors.mock.restore() }

  // a run that synced with per-file errors is still a run (ok:false, no reason) — the worker prints those errors
  syncResult = okSync({ ok: false, errors: ['sheet append (2 rows): quota'] })
  await routes.sync(req.sync())
  assert.deepEqual(ticks, ['footage'])
})

test('footage/sync: no secret and no admin session → 401, nothing runs', async () => {
  const r = await routes.sync(new Request('https://probook.test/api/internal/footage/sync', { headers: { 'x-footage-sync-secret': 'wrong' } }))
  assert.equal(r.status, 401)
  assert.equal(calls.sync, undefined)
})
