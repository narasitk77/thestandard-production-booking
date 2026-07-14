// Footage-ready worker — supervised by start.sh on every container boot. Polls
// the in-process /api/internal/footage-ready/run endpoint once per interval
// (30 min by default), which sweeps recent bookings and auto-notifies once a
// booking's footage is complete + settled (see src/lib/footage-ready.ts).
//
// Stays dormant when FOOTAGE_READY_WORKER_ENABLED is unset / '0' / 'false' —
// the supervisor loop still restarts this script every 5s, so flipping the env
// var live in Portainer and restarting the stack turns it on without a code
// change. Mirrors scripts/reminders-worker.js (interval, secret resolution,
// SIGTERM handling) so anyone who's debugged that one knows the shape of this.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.FOOTAGE_READY_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[footage-ready] FOOTAGE_READY_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  60_000,
  parsePositiveInt(process.env.FOOTAGE_READY_INTERVAL_MS, 30 * 60_000),
)
const baseUrl = (process.env.FOOTAGE_READY_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.FOOTAGE_READY_SECRET ||
  process.env.REMINDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn(
    '[footage-ready] WARN: no secret configured (FOOTAGE_READY_SECRET / REMINDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.',
  )
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/footage-ready/run`
    const res = await fetch(url, {
      headers: secret ? { 'x-footage-ready-secret': secret } : {},
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[footage-ready] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    console.log(
      `[footage-ready] scanned=${json.scanned} eligible=${json.eligible} walked=${json.walked} notified=${(json.notified || []).length} settling=${(json.settling || []).length} deferred=${json.deferred} errors=${(json.errors || []).length}`,
    )
  } catch (err) {
    console.error('[footage-ready] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[footage-ready] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(
  `[footage-ready] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`,
)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 60_000)
timer = setInterval(runOnce, intervalMs)
