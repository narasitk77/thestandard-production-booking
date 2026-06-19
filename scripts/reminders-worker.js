// Reminder worker — supervised by start.sh on every container boot. Polls the
// in-process /api/internal/reminders/run endpoint once per interval (daily by
// default), which runs the scan + dispatch (Discord + email digest).
//
// Stays dormant when REMINDERS_WORKER_ENABLED is unset / '0' / 'false' — the
// supervisor loop still restarts this script every 5s, so flipping the env var
// live in Portainer and restarting the stack turns it on without a code change.
//
// Mirrors scripts/footage-sheet-sync-worker.js (interval, secret resolution,
// SIGTERM handling) so anyone who's debugged that one knows the shape of this.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.REMINDERS_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[reminders] REMINDERS_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  60_000,
  parsePositiveInt(process.env.REMINDERS_WORKER_INTERVAL_MS, 24 * 60 * 60_000),
)
const baseUrl = (process.env.REMINDERS_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.REMINDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn(
    '[reminders] WARN: no secret configured (REMINDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.',
  )
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/reminders/run`
    const res = await fetch(url, {
      headers: secret ? { 'x-reminders-secret': secret } : {},
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[reminders] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    console.log(
      `[reminders] detected=${json.detected} created=${json.created} resolved=${json.resolved} open=${json.openCount} discord=${json.dispatched?.discord} email=${json.dispatched?.email}`,
    )
  } catch (err) {
    console.error('[reminders] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[reminders] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(
  `[reminders] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`,
)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 60_000)
timer = setInterval(runOnce, intervalMs)
