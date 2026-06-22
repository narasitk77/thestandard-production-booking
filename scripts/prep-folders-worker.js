// Prep-folders worker — supervised by start.sh on every container boot. Hourly,
// hits the in-process /api/internal/prep-folders/run endpoint, which pre-creates
// the Drive boxes (CAM-A.. folders) for the day's shoots so the folders are
// waiting. Idempotent, no moving.
//
// ON BY DEFAULT (folder pre-creation is safe + idempotent). Set
// PREP_FOLDERS_WORKER_ENABLED=0 / false / no to disable. Mirrors
// scripts/reminders-worker.js for interval / secret / SIGTERM handling.

const { parsePositiveInt } = require('./lib/env')

const flag = String(process.env.PREP_FOLDERS_WORKER_ENABLED ?? '').toLowerCase()
if (flag === '0' || flag === 'false' || flag === 'no') {
  console.log('[prep-folders] PREP_FOLDERS_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  300_000,
  parsePositiveInt(process.env.PREP_FOLDERS_INTERVAL_MS, 60 * 60_000), // hourly
)
const baseUrl = (process.env.PREP_FOLDERS_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.PREP_FOLDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[prep-folders] WARN: no secret (PREP_FOLDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/prep-folders/run`
    const res = await fetch(url, { headers: secret ? { 'x-prep-folders-secret': secret } : {} })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[prep-folders] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    if (json.skipped) {
      console.log(`[prep-folders] skipped: ${json.reason}`)
    } else {
      console.log(`[prep-folders] today=${json.total} prepared=${json.prepared} errors=${json.errors}`)
    }
  } catch (err) {
    console.error('[prep-folders] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[prep-folders] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[prep-folders] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 90_000)
timer = setInterval(runOnce, intervalMs)
