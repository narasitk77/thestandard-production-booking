// v1.212 — daily export to Lark. Supervised by start.sh on every container boot.
//
// Thin scheduler, like every other worker here: it sleeps until its hour and
// calls ONE endpoint. All the work (read DB → gzip snapshot → Lark Drive → Lark
// Base) happens in the app process, which is the only one holding DATABASE_URL
// and the Lark app credentials.
//
// 23:00 BKK by default, on purpose: the nightly Claude Code health check runs at
// midnight, so it audits an export that is one hour old rather than yesterday's.
// A watcher that can only ever see stale evidence is a watcher that cannot tell
// "ran late" from "did not run".
//
// Stays dormant when LARK_EXPORT_ENABLED is unset / '0' / 'false'. The endpoint
// re-checks the same flag, so a stray curl cannot ship data to Lark either.

const { parsePositiveInt, appBaseUrl } = require('./lib/env')
const { httpRequest } = require('./lib/http')

const enabled = String(process.env.LARK_EXPORT_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[lark-export] LARK_EXPORT_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.LARK_EXPORT_HOUR, 23)))
const baseUrl = appBaseUrl(process.env.LARK_EXPORT_URL)
const secret = (
  process.env.LARK_EXPORT_SECRET ||
  process.env.BACKUP_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[lark-export] WARN: no secret configured — every request will 401.')
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
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/lark-export/run`
    const res = await httpRequest(url, {
      method: 'POST',
      headers: secret ? { 'x-lark-export-secret': secret } : {},
    })
    if (!res.ok) {
      console.error(`[lark-export] ${res.status}: ${res.text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(res.text)
    if (json.skipped) { console.log(`[lark-export] skipped: ${json.reason}`); return }
    // archive and mirror are reported SEPARATELY — never collapse them into one
    // "ok", or a night where the file failed but the Base wrote reads as fine.
    console.log(
      `[lark-export] archive=${json.archiveOk ? 'ok' : 'FAILED'} file=${json.fileName} ` +
      `size=${json.sizeBytes}B mirror=${json.mirrorOk === null ? 'off' : (json.mirrorOk ? 'ok' : 'FAILED')} ` +
      `vanished=${json.tombstoneCount ?? json.vanished}`,
    )
    for (const e of (json.errors || []).slice(0, 10)) console.error(`[lark-export]   ${e}`)
  } catch (err) {
    console.error('[lark-export] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let dailyTimer
function scheduleDaily() {
  const wait = msUntilNextRun()
  console.log(`[lark-export] next run in ${Math.round(wait / 60000)} min (~${String(targetHourBkk).padStart(2, '0')}:00 BKK)`)
  setTimeout(async () => {
    await runOnce()
    dailyTimer = setInterval(runOnce, DAY_MS)
  }, wait)
}

function shutdown(signal) {
  console.log(`[lark-export] received ${signal}, exiting`)
  if (dailyTimer) clearInterval(dailyTimer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[lark-export] worker started; daily at ${String(targetHourBkk).padStart(2, '0')}:00 BKK; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleDaily()
