// Landing drop-folder lifecycle worker — supervised by start.sh on every
// container boot. Once a NIGHT (default 19:00 Asia/Bangkok, the EVENING BEFORE
// each shoot day) it calls /api/internal/landing/manage, which creates the NEXT
// day's landing drop folders on the "Production Team" drive and trashes the
// past-empty ones — so the drop drive stays lean (only upcoming + in-flight
// shoots). Policy: docs/landing-folder-policy.md.
//
// ON BY DEFAULT (this is the desired steady-state behavior). Set
// LANDING_WORKER_ENABLED=0 to disable. Mirrors scripts/shoot-marker-worker.js
// (nightly scheduler, secret resolution, SIGTERM handling). Mutating (dryRun=0);
// idempotent, only trashes EMPTY regenerable folders to recoverable Drive trash.

const { parsePositiveInt, appBaseUrl, exitDisabled } = require('./lib/env')
const { httpRequest } = require('./lib/http')

const enabled = String(process.env.LANDING_WORKER_ENABLED ?? '1').toLowerCase()
if (enabled === '0' || enabled === 'false' || enabled === 'no') {
  exitDisabled('landing', 'LANDING_WORKER_ENABLED')
  return
}

const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.LANDING_WORKER_HOUR, 19)))

// v1.220 — the NOON prune, taken back in-house. It used to be a Hermes cron job
// on a laptop; prod's NEXTAUTH_SECRET was rotated on 2026-08-25 and the laptop
// kept the old copy, so the job 401'd for 13 straight runs and nobody acted on
// the warnings. In here it resolves the secret from the same process env as the
// evening sweep, so it cannot drift, and it does not care whether a Mac is awake.
//
// Why it earns its keep alongside the 19:00 sweep: the sweep only trashes
// folders whose Production ID still matches a Booking row AND whose shoot is
// older than the grace window. The prune has neither restriction, so it clears
// empty orphans the sweep refuses to touch — on 2026-09-09 that was 14 folders
// the sweep had left behind. Both only ever trash EMPTY folders, so they cannot
// fight each other. Past-only safety now lives server-side in
// pruneLandingToToday (v1.220), not in the caller.
const pruneEnabled = !['0', 'false', 'no'].includes(String(process.env.LANDING_PRUNE_ENABLED ?? '1').toLowerCase())
const pruneHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.LANDING_PRUNE_HOUR, 12)))
const baseUrl = appBaseUrl(process.env.LANDING_MANAGE_URL)
const secret = (
  process.env.PREP_FOLDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[landing] WARN: no secret (PREP_FOLDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

const DAY_MS = 24 * 60 * 60 * 1000

// ms until the next occurrence of hourBkk (BKK = fixed UTC+7, no DST).
function msUntilNextRun(hourBkk) {
  const targetUtcHour = (hourBkk - 7 + 24) % 24
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const res = await httpRequest(`${baseUrl.replace(/\/$/, '')}/api/internal/landing/manage?dryRun=0`, { headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = res.text
    if (!res.ok) { console.error(`[landing] ${res.status}: ${body.slice(0, 500)}`); return }
    const j = JSON.parse(body)
    if (j.skipped) { console.log(`[landing] skipped: ${j.reason}`); return }
    console.log(`[landing] ${j.targetDay}: created=${j.created} removedPastEmpty=${j.removedPastEmpty} keptRecent=${j.keptRecent} errors=${(j.createErrors || 0) + (j.removeErrors || 0)}`)
  } catch (err) {
    console.error('[landing] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let pruning = false
async function pruneOnce() {
  if (pruning) return
  pruning = true
  try {
    const res = await httpRequest(`${baseUrl.replace(/\/$/, '')}/api/internal/landing/manage?prune=today&dryRun=0`, { headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = res.text
    if (!res.ok) { console.error(`[landing-prune] ${res.status}: ${body.slice(0, 500)}`); return }
    const j = JSON.parse(body)
    if (j.skipped) { console.log(`[landing-prune] skipped: ${j.reason}`); return }
    const stale = (j.keptWithFiles || []).length + (j.keptManual || []).length
    console.log(`[landing-prune] ${j.today}: trashed=${j.trashed} keptToday=${j.keptToday} stale=${stale} keptFuture=${(j.keptFuture || []).length} errors=${j.errors}`)
  } catch (err) {
    console.error('[landing-prune] run failed:', err?.message || err)
  } finally {
    pruning = false
  }
}

let dailyTimer
let pruneTimer
function scheduleNightly() {
  const wait = msUntilNextRun(targetHourBkk)
  console.log(`[landing] next run in ${Math.round(wait / 60000)} min (~${String(targetHourBkk).padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => { await runOnce(); dailyTimer = setInterval(runOnce, DAY_MS) }, wait)
}

function schedulePrune() {
  if (!pruneEnabled) { console.log('[landing-prune] LANDING_PRUNE_ENABLED=0 — noon prune off.'); return }
  const wait = msUntilNextRun(pruneHourBkk)
  console.log(`[landing-prune] next run in ${Math.round(wait / 60000)} min (~${String(pruneHourBkk).padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => { await pruneOnce(); pruneTimer = setInterval(pruneOnce, DAY_MS) }, wait)
}

function shutdown(signal) {
  console.log(`[landing] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  if (pruneTimer) clearInterval(pruneTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[landing] worker started; nightly at ${String(targetHourBkk).padStart(2, '0')}:00 BKK; prune ${pruneEnabled ? `at ${String(pruneHourBkk).padStart(2, '0')}:00 BKK` : 'OFF'}; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleNightly()
schedulePrune()
