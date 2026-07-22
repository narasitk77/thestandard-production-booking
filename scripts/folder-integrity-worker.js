// Folder-integrity worker — supervised by start.sh on every container boot.
//
// Every FOLDER_INTEGRITY_INTERVAL_MS (default 60 min) it calls
// /api/internal/folder-integrity/run?dryRun=0, which walks every active
// booking and repairs its Drive structure: missing box / EP / CAM+AUDIO
// folders are created, stale folder names (job or episode retitled, hand-made
// "Cam A") are renamed IN PLACE, and today/tomorrow's crew drop zone is topped
// up. It never moves or trashes anything; anything ambiguous is emailed for a
// human instead.
//
// ON BY DEFAULT — this is the standing "stop finding folder bugs from the crew"
// pass. Set FOLDER_INTEGRITY_WORKER_ENABLED=0 to disable. The first run after
// boot is delayed (FOLDER_INTEGRITY_START_DELAY_MS, default 4 min) so it never
// races the prep-folders sweep or a deploy's cold start.

const { parsePositiveInt } = require('./lib/env')

const enabled = String(process.env.FOLDER_INTEGRITY_WORKER_ENABLED ?? '1').toLowerCase()
if (enabled === '0' || enabled === 'false' || enabled === 'no') {
  console.log('[folder-integrity] FOLDER_INTEGRITY_WORKER_ENABLED=0 — disabled, exiting (supervisor re-launches in 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = parsePositiveInt(process.env.FOLDER_INTEGRITY_INTERVAL_MS, 60 * 60 * 1000)
const startDelayMs = parsePositiveInt(process.env.FOLDER_INTEGRITY_START_DELAY_MS, 4 * 60 * 1000)
const baseUrl = (process.env.FOLDER_INTEGRITY_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.PREP_FOLDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[folder-integrity] WARN: no secret (PREP_FOLDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

let running = false
async function runOnce() {
  if (running) return
  running = true
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/folder-integrity/run?dryRun=0`, {
      headers: secret ? { 'x-reconcile-secret': secret } : {},
    })
    const body = await res.text()
    if (!res.ok) { console.error(`[folder-integrity] ${res.status}: ${body.slice(0, 400)}`); return }
    const j = JSON.parse(body)
    if (j.skipped) { console.log(`[folder-integrity] skipped: ${j.reason}`); return }
    const f = j.fixed || {}
    const changed = Object.values(f).reduce((n, v) => n + (Number(v) || 0), 0)
    console.log(
      `[folder-integrity] checked=${j.checked}/${j.scanned} fixed=${changed}` +
      ` (box +${f.boxCreated || 0}/~${f.boxRenamed || 0}, ep +${f.epCreated || 0}/~${f.epRenamed || 0},` +
      ` cam +${f.camCreated || 0}/~${f.camNormalized || 0}, landing ${f.landingRepaired || 0})` +
      ` warn=${(j.warnings || []).length} errors=${(j.errors || []).length} deferred=${j.deferred || 0}`,
    )
  } catch (err) {
    console.error('[folder-integrity] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[folder-integrity] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[folder-integrity] worker started; every ${Math.round(intervalMs / 60000)} min (first run in ${Math.round(startDelayMs / 60000)} min); baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
setTimeout(() => { runOnce(); timer = setInterval(runOnce, intervalMs) }, startDelayMs)
