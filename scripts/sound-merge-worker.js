// Sound-merge worker — supervised by start.sh on every container boot. Hourly,
// hits the in-process /api/internal/sound-merge/run endpoint, which copies staged
// audio (_SOUND-STAGING/<Production ID>/) into each booking's video box AUDIO
// folder. Idempotent (dedup by name+size), copy-only (staging stays the master).
//
// ON BY DEFAULT (idempotent + safe). Set SOUND_MERGE_WORKER_ENABLED=0 / false / no
// to disable. Mirrors scripts/prep-folders-worker.js.

const { parsePositiveInt } = require('./lib/env')

const flag = String(process.env.SOUND_MERGE_WORKER_ENABLED ?? '').toLowerCase()
if (flag === '0' || flag === 'false' || flag === 'no') {
  console.log('[sound-merge] SOUND_MERGE_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  300_000,
  parsePositiveInt(process.env.SOUND_MERGE_INTERVAL_MS, 60 * 60_000), // hourly
)
const baseUrl = (process.env.SOUND_MERGE_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.SOUND_MERGE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[sound-merge] WARN: no secret (SOUND_MERGE_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/sound-merge/run`
    const res = await fetch(url, { headers: secret ? { 'x-sound-merge-secret': secret } : {} })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[sound-merge] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    if (json.skipped) {
      console.log(`[sound-merge] skipped: ${json.reason}`)
    } else {
      console.log(`[sound-merge] bookings=${json.bookings} staged=${json.staged} merged=${json.merged} errors=${json.errors}`)
    }
  } catch (err) {
    console.error('[sound-merge] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[sound-merge] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[sound-merge] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
// Delay first run so Next.js finishes booting before we hit the route.
setTimeout(runOnce, 120_000)
timer = setInterval(runOnce, intervalMs)
