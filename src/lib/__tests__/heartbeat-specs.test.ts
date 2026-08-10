// Dead-man-switch tests for workerSpecs() / evaluateWorkers().
//
// v1.172 closed a gap that lasted months: five of the twelve supervised workers
// (prep-folders, folder-integrity, shoot-marker, landing, shoot-review) had no
// spec at all, so if one died the only symptom was folders quietly not getting
// made. The first test below is the guard that stops that gap reopening — add a
// scripts/*-worker.js without a matching spec and it fails.
//
// The rest pin the two things that are easy to get subtly wrong: each worker's
// on-by-default vs off-by-default rule (they differ, per worker) and the
// staleness boundary for a daily worker.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// evaluateWorkers reads the heartbeat table; swap Prisma for an in-memory list.
let rows: { key: string; at: Date }[] = []
mock.module('../db', {
  namedExports: {
    prisma: {
      systemHeartbeat: {
        findMany: async () => rows,
        findUnique: async ({ where }: any) => rows.find((r) => r.key === where.key) ?? null,
        upsert: async () => undefined,
      },
    },
  },
})

let heartbeat: typeof import('../heartbeat')
before(async () => {
  heartbeat = await import('../heartbeat')
})

/**
 * Run a body with a temporarily-patched env, always restoring it.
 *
 * Restores after the body SETTLES, not after it returns: a plain try/finally
 * around an async body puts the env back while the body is still suspended, so
 * the code under test reads the original env and the test silently passes for
 * the wrong reason. (It did — that is why this comment exists.)
 */
function withEnv<T>(patch: Record<string, string | undefined>, body: () => T): T {
  // A plain array, not a Map: this tsconfig has no downlevelIteration, so
  // for-of over Map entries does not compile (see commit d5f2839).
  const saved: [string, string | undefined][] = []
  for (const k of Object.keys(patch)) {
    saved.push([k, process.env[k]])
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  let result: T
  try {
    result = body()
  } catch (e) {
    restore()
    throw e
  }
  if (result && typeof (result as any).then === 'function') {
    return (result as any).then(
      (v: unknown) => { restore(); return v },
      (e: unknown) => { restore(); throw e },
    ) as T
  }
  restore()
  return result
}

// Which spec key belongs to which worker script. Not derivable from the
// filename (footage-sheet-sync-worker.js ticks 'footage'), so it is written out
// — and the test asserts the table itself stays complete, which is the point:
// a new worker script cannot be added without landing here first.
const SCRIPT_TO_KEY: Record<string, string> = {
  'backup-worker.js': 'backup',
  'calendar-reconcile-worker.js': 'calendar-reconcile',
  'folder-integrity-worker.js': 'folder-integrity',
  'footage-ready-worker.js': 'footage-ready',
  'footage-sheet-sync-worker.js': 'footage',
  'landing-worker.js': 'landing',
  'prep-folders-worker.js': 'prep-folders',
  'reminders-worker.js': 'reminders',
  'shoot-marker-worker.js': 'shoot-marker',
  'shoot-review-worker.js': 'shoot-review',
  'sound-merge-worker.js': 'sound-merge',
  'video-merge-worker.js': 'video-merge',
}

test('every supervised worker script has a heartbeat spec', () => {
  const dir = path.join(process.cwd(), 'scripts')
  const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('-worker.js')).sort()

  const unmapped = scripts.filter((f) => !SCRIPT_TO_KEY[f])
  assert.deepEqual(
    unmapped, [],
    `new worker script(s) with no entry in SCRIPT_TO_KEY: ${unmapped.join(', ')} — ` +
    'add the mapping AND a spec in workerSpecs(), or a dead worker will be invisible',
  )

  const specKeys = new Set(heartbeat.workerSpecs().map((s) => s.key))
  const missing = scripts.map((f) => SCRIPT_TO_KEY[f]).filter((k) => !specKeys.has(k))
  assert.deepEqual(missing, [], `worker(s) with no spec in workerSpecs(): ${missing.join(', ')}`)
})

test('every spec key is one a route actually writes — no spec for a key nothing ticks', () => {
  // A spec whose key is never recorded reports neverTicked forever; a spec
  // pointed at the WRONG key (e.g. the once-a-day 'digest:folder-integrity'
  // gate) would look permanently fresh and hide a dead worker. Both are worse
  // than no spec, so check the source for a matching recordHeartbeat call.
  const src = fs
    .readdirSync(path.join(process.cwd(), 'src/app/api/internal'), { recursive: true, encoding: 'utf8' })
    .filter((f) => typeof f === 'string' && f.endsWith('route.ts'))
    .map((f) => fs.readFileSync(path.join(process.cwd(), 'src/app/api/internal', f), 'utf8'))
    .join('\n')

  const written = new Set(
    (src.match(/recordHeartbeat\('[^']+'/g) || []).map((m) => m.replace(/^recordHeartbeat\('/, '').replace(/'$/, '')),
  )
  const orphans = heartbeat.workerSpecs().map((s) => s.key).filter((k) => !written.has(k))
  assert.deepEqual(orphans, [], `spec key(s) nothing ever records: ${orphans.join(', ')}`)
  assert.ok(!written.has('digest:folder-integrity'), 'the daily digest gate must never be used as a liveness tick')
})

test('folder-integrity ticks on isWorker, not on !dryRun', () => {
  // FOLDER_INTEGRITY_APPLY defaults to '0', so in a stack that has not opted
  // into repairs the worker calls the route with ?dryRun=1 every hour, forever.
  // Gating the tick on !dryRun there means it never ticks, the spec says the
  // worker is enabled, and ~3h later health-summary starts returning 503 for a
  // worker that is in perfect health. Prod happens to set APPLY=1 and would
  // hide this; staging would not.
  const route = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/internal/folder-integrity/run/route.ts'),
    'utf8',
  )
  assert.match(
    route,
    /if \(allowed\.isWorker\) await recordHeartbeat\('folder-integrity'\)/,
    'folder-integrity liveness must key off allowed.isWorker — a report-only pass is still a live pass',
  )
})

test('on-by-default workers stay enabled when their env var is unset', () => {
  for (const [key, env] of [
    ['prep-folders', 'PREP_FOLDERS_WORKER_ENABLED'],
    ['folder-integrity', 'FOLDER_INTEGRITY_WORKER_ENABLED'],
    ['landing', 'LANDING_WORKER_ENABLED'],
    ['sound-merge', 'SOUND_MERGE_WORKER_ENABLED'],
    ['video-merge', 'VIDEO_MERGE_WORKER_ENABLED'],
  ] as const) {
    const on = withEnv({ [env]: undefined }, () => heartbeat.workerSpecs().find((s) => s.key === key)!)
    assert.equal(on.enabled, true, `${key} should be ON when ${env} is unset`)
    for (const off of ['0', 'false', 'no', 'NO']) {
      const spec = withEnv({ [env]: off }, () => heartbeat.workerSpecs().find((s) => s.key === key)!)
      assert.equal(spec.enabled, false, `${key} should be OFF when ${env}=${off}`)
    }
  }
})

test('off-by-default workers stay disabled until explicitly switched on', () => {
  for (const [key, env] of [
    ['shoot-marker', 'SHOOT_MARKER_WORKER_ENABLED'],
    ['shoot-review', 'SHOOT_REVIEW_ENABLED'],
    ['reminders', 'REMINDERS_WORKER_ENABLED'],
    ['backup', 'BACKUP_WORKER_ENABLED'],
    ['footage', 'FOOTAGE_WORKER_ENABLED'],
  ] as const) {
    const off = withEnv({ [env]: undefined }, () => heartbeat.workerSpecs().find((s) => s.key === key)!)
    assert.equal(off.enabled, false, `${key} should be OFF when ${env} is unset`)
    const on = withEnv({ [env]: '1' }, () => heartbeat.workerSpecs().find((s) => s.key === key)!)
    assert.equal(on.enabled, true, `${key} should be ON when ${env}=1`)
  }
})

test('a daily worker is fresh at 25h and stale at 27h', async () => {
  // 24h interval + the 2h grace in evaluateWorkers = alert at ~26h. A run that
  // lands a couple of hours late (the BKK hour gate drifts across restarts)
  // must not page anyone; a wholly missed day must.
  const HOUR = 3_600_000
  await withEnv({ SHOOT_MARKER_WORKER_ENABLED: '1' }, async () => {
    rows = [{ key: 'shoot-marker', at: new Date(Date.now() - 25 * HOUR) }]
    let w = (await heartbeat.evaluateWorkers()).find((x) => x.key === 'shoot-marker')!
    assert.equal(w.stale, false, '25h old should still be fresh')

    rows = [{ key: 'shoot-marker', at: new Date(Date.now() - 27 * HOUR) }]
    w = (await heartbeat.evaluateWorkers()).find((x) => x.key === 'shoot-marker')!
    assert.equal(w.stale, true, '27h old should be stale')
  })
})

test('a worker that has never ticked is reported but not stale', async () => {
  // The window right after a deploy: landing only runs at 19:00 BKK, so for
  // most of a day it legitimately has no tick. Alerting there would train
  // everyone to ignore the alert.
  await withEnv({ LANDING_WORKER_ENABLED: undefined }, async () => {
    rows = []
    const w = (await heartbeat.evaluateWorkers()).find((x) => x.key === 'landing')!
    assert.equal(w.enabled, true)
    assert.equal(w.neverTicked, true)
    assert.equal(w.stale, false)
  })
})

test('a disabled worker is never stale however old its last tick', async () => {
  await withEnv({ SHOOT_REVIEW_ENABLED: undefined }, async () => {
    rows = [{ key: 'shoot-review', at: new Date(Date.now() - 400 * 3_600_000) }]
    const w = (await heartbeat.evaluateWorkers()).find((x) => x.key === 'shoot-review')!
    assert.equal(w.enabled, false)
    assert.equal(w.stale, false)
  })
})
