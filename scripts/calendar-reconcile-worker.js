const { parsePositiveInt } = require('./lib/env')

const intervalMs = Math.max(
  60_000,
  parsePositiveInt(process.env.CALENDAR_RECONCILE_INTERVAL_MS, 10 * 60_000),
)
const baseUrl = (process.env.CALENDAR_RECONCILE_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.CALENDAR_RECONCILE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  // The internal endpoint also accepts an admin session, but the worker runs
  // headless — without a secret it will get 401s forever. Surface it loudly
  // instead of silently looping.
  console.warn(
    '[calendar-reconcile] WARN: no secret configured (CALENDAR_RECONCILE_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.',
  )
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/calendar/reconcile?limit=50`
    const res = await fetch(url, {
      headers: secret ? { 'x-reconcile-secret': secret } : {},
    })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[calendar-reconcile] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    const changed = (json.patched || 0) + (json.created || 0) + (json.failed || 0)
    if (changed > 0) {
      console.log(
        `[calendar-reconcile] checked=${json.checked} ok=${json.ok} patched=${json.patched} created=${json.created} failed=${json.failed}`,
      )
    }
  } catch (err) {
    console.error('[calendar-reconcile] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

// Container-friendly shutdown: stop the timer on SIGTERM/SIGINT so the
// process can exit cleanly when Docker stops the container instead of
// hanging until the SIGKILL grace period expires.
let timer
function shutdown(signal) {
  console.log(`[calendar-reconcile] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(
  `[calendar-reconcile] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`,
)
setTimeout(runOnce, 30_000)
timer = setInterval(runOnce, intervalMs)
