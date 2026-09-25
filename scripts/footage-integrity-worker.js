// Footage integrity worker (v1.221) — supervised by start.sh on every container
// boot. Once a day (default 13:00 Asia/Bangkok, after the noon landing prune has
// settled) it calls /api/internal/footage-integrity/run, which walks each recent
// booking's project box and reports files that are structurally present but
// obviously wrong: 0-byte uploads, two files sharing one name in one folder, and
// episodes that have sound but no picture.
//
// REPORT ONLY. The endpoint has no apply path at all — see
// src/lib/footage-integrity.ts for why repair is left to a human with the card.
//
// ON by default. FOOTAGE_INTEGRITY_ENABLED=0 turns it off.

const { parsePositiveInt, appBaseUrl, exitDisabled } = require('./lib/env')
const { httpRequest } = require('./lib/http')

const enabled = String(process.env.FOOTAGE_INTEGRITY_ENABLED ?? '1').toLowerCase()
if (enabled === '0' || enabled === 'false' || enabled === 'no') {
  exitDisabled('footage-integrity', 'FOOTAGE_INTEGRITY_ENABLED')
}

const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.FOOTAGE_INTEGRITY_HOUR, 13)))
const days = Math.max(1, parsePositiveInt(process.env.FOOTAGE_INTEGRITY_DAYS, 30))
const limit = Math.max(1, parsePositiveInt(process.env.FOOTAGE_INTEGRITY_LIMIT, 60))
const baseUrl = appBaseUrl(process.env.FOOTAGE_INTEGRITY_URL)
// No bespoke FOOTAGE_INTEGRITY_SECRET on purpose: a new secret is a new thing
// that can be set on the stack, forgotten in compose, and 401 in silence — the
// exact failure that hid the landing cron for 13 days. internalSecretAllowed
// accepts ANY configured secret, so riding the shared ones cannot drift.
const secret = (
  process.env.PREP_FOLDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[footage-integrity] WARN: no secret configured — every request will 401.')
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
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/footage-integrity/run?days=${days}&limit=${limit}`
    const res = await httpRequest(url, { headers: secret ? { 'x-footage-integrity-secret': secret } : {} })
    const body = res.text
    if (!res.ok) { console.error(`[footage-integrity] ${res.status}: ${body.slice(0, 500)}`); return }
    const j = JSON.parse(body)
    if (j.skipped) { console.log(`[footage-integrity] skipped: ${j.reason}`); return }
    console.log(`[footage-integrity] scanned=${j.scanned} withIssues=${j.withIssues} issues=${(j.issues || []).length} errors=${j.errors}`)
  } catch (err) {
    console.error('[footage-integrity] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let dailyTimer
function scheduleDaily() {
  const wait = msUntilNextRun()
  console.log(`[footage-integrity] next run in ${Math.round(wait / 60000)} min (~${String(targetHourBkk).padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => { await runOnce(); dailyTimer = setInterval(runOnce, DAY_MS) }, wait)
}

function shutdown(signal) {
  console.log(`[footage-integrity] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[footage-integrity] worker started; daily at ${String(targetHourBkk).padStart(2, '0')}:00 BKK; days=${days} limit=${limit}; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleDaily()
