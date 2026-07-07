// Video-merge worker — supervised by start.sh on every container boot.
//
// v1.127 — "sync จบคือจบ": watches the Synology Cloud Sync status (the NAS that
// mirrors camera cards into the flat "Production Team" Shared Drive) and runs
// the in-process /api/internal/video-merge/run the moment the sync turns GREEN
// (status "uptodate"), so footage lands in the Video 2026 boxes without anyone
// pressing the admin button. The run itself is idempotent + resumable (MOVEs;
// re-runs only handle the remainder), so firing "too often" is harmless.
//
// Two modes:
//   • GATED  — NAS_DSM_URL + NAS_DSM_USER + NAS_DSM_PASS set: poll the DSM
//     Cloud Sync API (SYNO.CloudSync list_conn) every VIDEO_MERGE_POLL_MS and
//     fire on the syncing→uptodate transition (plus once after boot when green,
//     plus a VIDEO_MERGE_FALLBACK_MS safety run). Cloud Sync has no webhooks —
//     polling the LAN API is the only reliable "sync done" signal.
//   • PLAIN  — DSM env not set: plain interval like sound-merge-worker
//     (VIDEO_MERGE_INTERVAL_MS, default hourly).
//
// ON BY DEFAULT. Set VIDEO_MERGE_WORKER_ENABLED=0 / false / no to disable.
// The DSM account should be a dedicated admin-group user with 2FA off (or a
// device token), IP-restricted to this host. Self-signed cert on :5001 is
// accepted by default (NAS_DSM_INSECURE_TLS=0 to require a valid cert).

const https = require('https')
const { parsePositiveInt } = require('./lib/env')

const flag = String(process.env.VIDEO_MERGE_WORKER_ENABLED ?? '').toLowerCase()
if (flag === '0' || flag === 'false' || flag === 'no') {
  console.log('[video-merge] VIDEO_MERGE_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const baseUrl = (process.env.VIDEO_MERGE_URL || 'http://127.0.0.1:3000').trim()
const secret = (
  process.env.VIDEO_MERGE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()
if (!secret) {
  console.warn('[video-merge] WARN: no secret (VIDEO_MERGE_SECRET / NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
}

// ── DSM (Synology) config ────────────────────────────────────────────────────
const DSM_URL = (process.env.NAS_DSM_URL || '').trim()            // e.g. https://192.168.21.220:5001
const DSM_USER = (process.env.NAS_DSM_USER || '').trim()
const DSM_PASS = process.env.NAS_DSM_PASS || ''
const DSM_CONN_NAME = (process.env.NAS_DSM_CONN_NAME || '').trim() // optional: Cloud Sync task display name
const DSM_INSECURE = String(process.env.NAS_DSM_INSECURE_TLS ?? '1') !== '0'
const gated = !!(DSM_URL && DSM_USER && DSM_PASS)

const pollMs = Math.max(30_000, parsePositiveInt(process.env.VIDEO_MERGE_POLL_MS, 60_000))          // DSM poll cadence
const minGapMs = Math.max(60_000, parsePositiveInt(process.env.VIDEO_MERGE_MIN_GAP_MS, 10 * 60_000)) // min gap between runs
const fallbackMs = Math.max(minGapMs, parsePositiveInt(process.env.VIDEO_MERGE_FALLBACK_MS, 6 * 60 * 60_000)) // safety re-run while green
const plainIntervalMs = Math.max(300_000, parsePositiveInt(process.env.VIDEO_MERGE_INTERVAL_MS, 60 * 60_000)) // PLAIN mode

/** GET a DSM webapi path (query string included) and parse the JSON envelope. */
function dsmGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, DSM_URL)
    const req = https.get(u, { rejectUnauthorized: !DSM_INSECURE, timeout: 15_000 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch { reject(new Error(`DSM non-JSON response (HTTP ${res.statusCode}): ${body.slice(0, 200)}`)) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('DSM request timed out')))
    req.on('error', reject)
  })
}

let sid = null
async function dsmLogin() {
  const q = new URLSearchParams({
    api: 'SYNO.API.Auth', version: '6', method: 'login',
    account: DSM_USER, passwd: DSM_PASS, session: 'CloudSync', format: 'sid',
  })
  const res = await dsmGet(`/webapi/entry.cgi?${q}`)
  if (!res?.success || !res?.data?.sid) {
    throw new Error(`DSM login failed (code ${res?.error?.code ?? '?'}) — check NAS_DSM_USER/PASS (and 2FA: code 403/406 means the account needs an OTP; exempt it or use a device token)`)
  }
  sid = res.data.sid
}

const SESSION_ERR = new Set([105, 106, 107, 119])
/** Cloud Sync connection list; re-logins once on an expired sid. */
async function dsmCloudSyncStatus(retried = false) {
  if (!sid) await dsmLogin()
  const q = new URLSearchParams({
    api: 'SYNO.CloudSync', version: '1', method: 'list_conn',
    is_tray: 'false', group_by: 'group_by_user', _sid: sid,
  })
  const res = await dsmGet(`/webapi/entry.cgi?${q}`)
  if (!res?.success) {
    const code = res?.error?.code
    if (!retried && SESSION_ERR.has(code)) { sid = null; return dsmCloudSyncStatus(true) }
    throw new Error(`DSM list_conn failed (code ${code ?? '?'})`)
  }
  return res.data || {}
}

/**
 * Reduce list_conn to one signal. Preference order: the named task
 * (NAS_DSM_CONN_NAME) → the single Google Drive ("gd") connection → the global
 * tray_status. GREEN = status "uptodate" with no unfinished files.
 */
function pickSyncState(data) {
  const conns = Array.isArray(data.conn) ? data.conn : []
  let c = null
  if (DSM_CONN_NAME) {
    c = conns.find((x) => String(x.task_display_name || '').toLowerCase() === DSM_CONN_NAME.toLowerCase())
    if (!c) console.warn(`[video-merge] NAS_DSM_CONN_NAME "${DSM_CONN_NAME}" not found among [${conns.map((x) => x.task_display_name).join(', ')}] — falling back`)
  }
  if (!c) {
    const gd = conns.filter((x) => String(x.type || '') === 'gd')
    if (gd.length === 1) c = gd[0]
  }
  if (c) return { green: String(c.status) === 'uptodate' && !(c.unfinished_files > 0), label: `"${c.task_display_name}" ${c.status}${c.unfinished_files ? ` (${c.unfinished_files} left)` : ''}` }
  return { green: String(data.tray_status) === 'uptodate', label: `tray ${data.tray_status}` }
}

// ── merge trigger ────────────────────────────────────────────────────────────
let running = false
let lastRunAt = 0
async function runMerge(why) {
  if (running) return
  running = true
  lastRunAt = Date.now()
  try {
    console.log(`[video-merge] running merge (${why})`)
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/video-merge/run?notify=1`
    const res = await fetch(url, { headers: secret ? { 'x-video-merge-secret': secret } : {} })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[video-merge] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    if (json.skipped) console.log(`[video-merge] skipped: ${json.reason}`)
    else console.log(`[video-merge] bookings=${json.bookings} files=${json.moved} folders=${json.movedFolders} dupLeft=${(json.landed ?? 0) - (json.moved ?? 0)} errors=${json.errors}`)
  } catch (err) {
    console.error('[video-merge] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

// ── main loops ───────────────────────────────────────────────────────────────
let wasSyncing = false
let firedSinceBoot = false
async function pollOnce() {
  let state
  try {
    state = pickSyncState(await dsmCloudSyncStatus())
  } catch (err) {
    console.error('[video-merge] DSM poll failed:', err?.message || err)
    return
  }
  if (!state.green) {
    if (!wasSyncing) console.log(`[video-merge] NAS syncing… (${state.label})`)
    wasSyncing = true
    return
  }
  const gapOk = Date.now() - lastRunAt >= minGapMs
  if (wasSyncing && gapOk) { wasSyncing = false; firedSinceBoot = true; await runMerge(`sync turned green — ${state.label}`); return }
  wasSyncing = false
  if (!firedSinceBoot) { firedSinceBoot = true; await runMerge(`first poll after boot is green — ${state.label}`); return }
  if (Date.now() - lastRunAt >= fallbackMs) await runMerge('fallback interval while green')
}

let timer
function shutdown(signal) {
  console.log(`[video-merge] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

if (gated) {
  console.log(`[video-merge] worker started (GATED on NAS Cloud Sync); dsm=${DSM_URL}; poll=${pollMs}ms; minGap=${minGapMs}ms; fallback=${fallbackMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
  // Delay first poll so Next.js finishes booting before a green NAS can trigger a run.
  setTimeout(pollOnce, 120_000)
  timer = setInterval(pollOnce, pollMs)
} else {
  console.log(`[video-merge] worker started (PLAIN interval — set NAS_DSM_URL/USER/PASS to gate on Cloud Sync); interval=${plainIntervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
  setTimeout(() => runMerge('interval'), 120_000)
  timer = setInterval(() => runMerge('interval'), plainIntervalMs)
}
