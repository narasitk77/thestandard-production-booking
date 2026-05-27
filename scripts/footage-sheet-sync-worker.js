// Footage sheet sync worker — supervised by start.sh on every container
// boot. Polls the in-process /api/internal/footage/sync endpoint at the
// configured interval, which does the Drive walk + sheet append.
//
// Stays dormant when FOOTAGE_WORKER_ENABLED is unset / '0' / 'false' —
// the supervisor loop still restarts this script every 5s, so flipping
// the env var live in Portainer and restarting the stack is enough to
// turn the worker on without a code change.
//
// Mirrors scripts/calendar-reconcile-worker.js (interval, secret resolution,
// SIGTERM handling) so anyone who's debugged that one already knows the
// shape of this one.

function parsePositiveInt(envValue, fallback) {
  if (envValue == null || envValue === '') return fallback
  const n = Number(envValue)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const enabled = String(process.env.FOOTAGE_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[footage-sync] FOOTAGE_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  // Stay alive a few seconds so the supervisor loop's 5s back-off
  // doesn't hammer this script's startup logging line.
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  60_000,
  parsePositiveInt(process.env.FOOTAGE_WORKER_INTERVAL_MS, 10 * 60_000),
)
const baseUrl = (process.env.FOOTAGE_SYNC_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.FOOTAGE_SYNC_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn(
    '[footage-sync] WARN: no secret configured (FOOTAGE_SYNC_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.',
  )
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/footage/sync`
    const res = await fetch(url, {
      headers: secret ? { 'x-footage-sync-secret': secret } : {},
    })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[footage-sync] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    if (json.reason) {
      // Idle reason (e.g. env var unset) — log once per tick, not as error
      console.log(`[footage-sync] idle: ${json.reason}`)
      return
    }
    const changed = (json.matched || 0) + (json.parsedNoBooking || 0) + (json.unparsed || 0)
    if (changed > 0 || (json.errors && json.errors.length > 0)) {
      console.log(
        `[footage-sync] scanned=${json.scanned} matched=${json.matched} parsed_no_booking=${json.parsedNoBooking} unparsed=${json.unparsed} retried=${json.retried} seen=${json.seen} errors=${(json.errors || []).length}`,
      )
      if (json.errors && json.errors.length > 0) {
        for (const e of json.errors.slice(0, 5)) console.error(`  - ${e}`)
      }
    }
  } catch (err) {
    console.error('[footage-sync] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[footage-sync] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(
  `[footage-sync] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`,
)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 45_000)
timer = setInterval(runOnce, intervalMs)
