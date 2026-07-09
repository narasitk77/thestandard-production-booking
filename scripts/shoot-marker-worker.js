// _SHOOT marker reconcile worker — supervised by start.sh on every container
// boot. Polls the in-process /api/internal/shoot-markers/reconcile endpoint at
// the configured interval, which enforces "one _SHOOT marker per booking" across
// AGN project boxes (trashes pre-migration box-level duplicates so the footage
// crawler stops filing two cards per shoot — Neo memo 2026-07-09 item 3).
//
// Stays dormant when SHOOT_MARKER_WORKER_ENABLED is unset / '0' / 'false' — the
// supervisor loop still restarts this script every 5s, so flipping the env var
// live in Portainer and restarting the stack turns it on without a code change.
//
// Mirrors scripts/footage-sheet-sync-worker.js (enabled gate, interval, secret
// resolution, SIGTERM handling). Runs with dryRun=0 (mutating) — the reconciler
// is idempotent and only trashes small, regenerable _SHOOT stubs to Shared-Drive
// trash (recoverable ~30 days); footage folders are never touched.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.SHOOT_MARKER_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[shoot-marker] SHOOT_MARKER_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  // hourly floor — marker drift is slow-moving; no need to hammer Drive.
  10 * 60_000,
  parsePositiveInt(process.env.SHOOT_MARKER_WORKER_INTERVAL_MS, 60 * 60_000),
)
const baseUrl = (process.env.SHOOT_MARKER_RECONCILE_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.SHOOT_MARKER_RECONCILE_SECRET ||
  process.env.CALENDAR_RECONCILE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[shoot-marker] WARN: no secret configured (SHOOT_MARKER_RECONCILE_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.')
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    // dryRun=0 → apply. The endpoint audits any run that actually changed Drive.
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/shoot-markers/reconcile?dryRun=0`
    const res = await fetch(url, { headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[shoot-marker] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    if (json.skipped) {
      console.log(`[shoot-marker] skipped: ${json.reason}`)
      return
    }
    const changed = (json.trashedDuplicates || 0) + (json.movedIntoBooking || 0) + (json.trashedStale || 0) + (json.dedupedInSubfolder || 0)
    if (changed > 0 || json.errors > 0) {
      console.log(`[shoot-marker] projects=${json.projects} dupTrashed=${json.trashedDuplicates} moved=${json.movedIntoBooking} staleTrashed=${json.trashedStale} deduped=${json.dedupedInSubfolder} errors=${json.errors}`)
    }
  } catch (err) {
    console.error('[shoot-marker] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[shoot-marker] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[shoot-marker] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
// Longer initial delay than the calendar worker — let the app finish booting +
// the heavier footage/calendar workers settle before we start walking Drive.
setTimeout(runOnce, 90_000)
timer = setInterval(runOnce, intervalMs)
