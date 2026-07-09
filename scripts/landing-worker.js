// Landing drop-folder lifecycle worker — supervised by start.sh on every
// container boot. Once a NIGHT (default 19:00 Asia/Bangkok, the EVENING BEFORE
// each shoot day) it calls /api/internal/landing/manage, which creates the NEXT
// day's landing drop folders on the "Production Team" drive and trashes the
// past-empty ones — so the drop drive stays lean (only upcoming + in-flight
// shoots). Policy: docs/landing-folder-policy.md.
//
// ON BY DEFAULT (this is the desired steady-state behavior). Set
// LANDING_WORKER_ENABLED=0 to disable. Mirrors scripts/shoot-marker-worker.js
// (nightly scheduler, secret resolution, SIGTERM handling). Mutating (dryRun=0);
// idempotent, only trashes EMPTY regenerable folders to recoverable Drive trash.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.LANDING_WORKER_ENABLED ?? '1').toLowerCase()
if (enabled === '0' || enabled === 'false' || enabled === 'no') {
  console.log('[landing] LANDING_WORKER_ENABLED=0 — disabled, exiting (supervisor re-launches in 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.LANDING_WORKER_HOUR, 19)))
const baseUrl = (process.env.LANDING_MANAGE_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.PREP_FOLDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[landing] WARN: no secret (PREP_FOLDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

const DAY_MS = 24 * 60 * 60 * 1000

// ms until the next targetHourBkk (BKK = fixed UTC+7, no DST).
function msUntilNextRun() {
  const targetUtcHour = (targetHourBkk - 7 + 24) % 24
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/landing/manage?dryRun=0`, { headers: secret ? { 'x-reconcile-secret': secret } : {} })
    const body = await res.text()
    if (!res.ok) { console.error(`[landing] ${res.status}: ${body.slice(0, 500)}`); return }
    const j = JSON.parse(body)
    if (j.skipped) { console.log(`[landing] skipped: ${j.reason}`); return }
    console.log(`[landing] ${j.targetDay}: created=${j.created} removedPastEmpty=${j.removedPastEmpty} keptRecent=${j.keptRecent} errors=${(j.createErrors || 0) + (j.removeErrors || 0)}`)
  } catch (err) {
    console.error('[landing] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let dailyTimer
function scheduleNightly() {
  const wait = msUntilNextRun()
  console.log(`[landing] next run in ${Math.round(wait / 60000)} min (~${String(targetHourBkk).padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => { await runOnce(); dailyTimer = setInterval(runOnce, DAY_MS) }, wait)
}

function shutdown(signal) {
  console.log(`[landing] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[landing] worker started; nightly at ${String(targetHourBkk).padStart(2, '0')}:00 BKK; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleNightly()
