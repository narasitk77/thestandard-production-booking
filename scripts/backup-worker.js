// DB backup worker — supervised by start.sh on every container boot. Polls the
// in-process /api/internal/backup/run endpoint once per interval (daily by
// default), which pg_dumps the DB, gzips it, and uploads to Google Drive.
//
// Stays dormant when BACKUP_WORKER_ENABLED is unset / '0' / 'false' — the
// supervisor loop still restarts this script every 5s, so flipping the env var
// live in Portainer and restarting the stack turns it on without a code change.
//
// Mirrors scripts/reminders-worker.js (interval, secret resolution, SIGTERM).

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.BACKUP_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[backup] BACKUP_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  60 * 60_000, // never tighter than hourly
  parsePositiveInt(process.env.BACKUP_INTERVAL_MS, 24 * 60 * 60_000),
)
const baseUrl = (process.env.BACKUP_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.BACKUP_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[backup] WARN: no secret (BACKUP_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Every request will 401.')
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/backup/run`
    const res = await fetch(url, { headers: secret ? { 'x-backup-secret': secret } : {} })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[backup] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    console.log(`[backup] ok file=${json.fileName} size=${json.sizeBytes}B pruned=${json.pruned}`)
  } catch (err) {
    console.error('[backup] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[backup] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[backup] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 90_000)
timer = setInterval(runOnce, intervalMs)
