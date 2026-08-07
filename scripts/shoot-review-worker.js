// Post-shoot peer review sender — supervised by start.sh on every container
// boot. Once a MORNING (default 10:00 Asia/Bangkok) it calls the in-process
// /api/internal/shoot-reviews/send endpoint, which invites everyone who worked
// a shoot that ended SHOOT_REVIEW_DELAY_DAYS ago (default 1) to rate the other
// teams.
//
// Stays dormant unless SHOOT_REVIEW_ENABLED=1 — and note the endpoint checks
// that flag too, so the worker cannot mail anyone by itself. 10:00 rather than
// the usual 03:00: this one emails PEOPLE, and a survey landing at 3am reads as
// a system that does not know anyone is asleep.
//
// Runs with dryRun=0 (sends for real). Every invite is unique per (booking,
// person), so a restart or a double run cannot invite anybody twice.

const { parsePositiveInt, appBaseUrl } = require('./lib/env')

const enabled = String(process.env.SHOOT_REVIEW_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[shoot-review] SHOOT_REVIEW_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.SHOOT_REVIEW_WORKER_HOUR, 10)))
const baseUrl = appBaseUrl(process.env.SHOOT_REVIEW_URL)
const secret = (
  process.env.RECONCILE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[shoot-review] WARN: no secret configured — every request will 403.')
}

const DAY_MS = 24 * 60 * 60 * 1000

// BKK is a fixed UTC+7 with no DST, so the target hour maps straight to UTC.
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
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/shoot-reviews/send?dryRun=0`
    const res = await fetch(url, { method: 'POST', headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[shoot-review] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    if (json.skipped) { console.log(`[shoot-review] skipped: ${json.reason}`); return }
    console.log(`[shoot-review] shootDate=${json.shootDate} scanned=${json.bookingsScanned} invited=${json.invited} mailed=${json.mailed} errors=${(json.errors || []).length}`)
    for (const e of (json.errors || []).slice(0, 10)) console.error(`[shoot-review]   ${e}`)
  } catch (err) {
    console.error('[shoot-review] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let dailyTimer
function scheduleDaily() {
  const wait = msUntilNextRun()
  console.log(`[shoot-review] next run in ${Math.round(wait / 60000)} min (~${targetHourBkk.toString().padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => {
    await runOnce()
    dailyTimer = setInterval(runOnce, DAY_MS)
  }, wait)
}

function shutdown(signal) {
  console.log(`[shoot-review] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[shoot-review] worker started; daily at ${targetHourBkk.toString().padStart(2, '0')}:00 BKK; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleDaily()
