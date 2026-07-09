// _SHOOT marker reconcile worker — supervised by start.sh on every container
// boot. Once a NIGHT (default 03:00 Asia/Bangkok) it calls the in-process
// /api/internal/shoot-markers/reconcile endpoint, which enforces "one _SHOOT
// marker per booking" across AGN project boxes AND audits each marker's content
// (Production ID + Gregorian date) against the DB, fixing drift and emailing a
// digest (Neo memo 2026-07-09). Nightly is plenty — marker drift is slow-moving.
//
// Stays dormant when SHOOT_MARKER_WORKER_ENABLED is unset / '0' / 'false' — the
// supervisor loop still restarts this script every 5s, so flipping the env var
// live in Portainer and restarting the stack turns it on without a code change.
//
// Runs with dryRun=0 (mutating): the reconciler is idempotent and only trashes
// small regenerable _SHOOT stubs to Shared-Drive trash (recoverable ~30 days);
// footage folders are never touched. The endpoint sends the report email.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.SHOOT_MARKER_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[shoot-marker] SHOOT_MARKER_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

// Target hour of day in Asia/Bangkok to run the nightly pass (0–23; default 3am).
const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.SHOOT_MARKER_WORKER_HOUR, 3)))
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

const DAY_MS = 24 * 60 * 60 * 1000

// ms until the next targetHourBkk in Asia/Bangkok. BKK is a fixed UTC+7 with no
// DST, so we can work in UTC: 03:00 BKK == 20:00 UTC the previous day.
function msUntilNextRun() {
  const targetUtcHour = (targetHourBkk - 7 + 24) % 24
  const now = new Date()
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0, 0,
  ))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    // dryRun=0 → apply. The endpoint audits + emails any run that changed Drive.
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/shoot-markers/reconcile?dryRun=0`
    const res = await fetch(url, { headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[shoot-marker] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    if (json.skipped) { console.log(`[shoot-marker] skipped: ${json.reason}`); return }
    const f = json.fixed || {}
    const changed = (f.duplicatesTrashed || 0) + (f.staleTrashed || 0) + (f.movedIntoBooking || 0) + (f.dedupedInSubfolder || 0) + (f.contentRewritten || 0) + (f.markersCreated || 0)
    console.log(`[shoot-marker] scanned ${json.scannedProjects}p/${json.scannedBookings}b · changed=${changed} warnings=${(json.warnings || []).length} errors=${json.errors}`)
  } catch (err) {
    console.error('[shoot-marker] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

// Nightly scheduler: sleep until the next target hour, run, then every 24h.
let dailyTimer
function scheduleNightly() {
  const wait = msUntilNextRun()
  console.log(`[shoot-marker] next run in ${Math.round(wait / 60000)} min (~${targetHourBkk.toString().padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => {
    await runOnce()
    dailyTimer = setInterval(runOnce, DAY_MS)
  }, wait)
}

function shutdown(signal) {
  console.log(`[shoot-marker] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[shoot-marker] worker started; nightly at ${targetHourBkk.toString().padStart(2, '0')}:00 BKK; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleNightly()
