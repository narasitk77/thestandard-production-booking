// Footage check worker (v1.221, v1.253) — supervised by start.sh on every container
// boot. Once a day (default 13:00 Asia/Bangkok, after the noon landing prune has
// settled) it walks EVERY booking shot in the last FOOTAGE_INTEGRITY_DAYS days,
// page by page, through /api/internal/footage-integrity/run, then posts one
// summary back so the team gets ONE chat message per run.
//
// What each page checks (src/lib/footage-integrity.ts): 0-byte uploads, duplicate
// names, sound without picture, originals that never arrived, missing Sony
// sidecars, files stranded in a trashed drop folder, and the editor's Media Pool
// (.drp) against the box. With FOOTAGE_CHECK_DOCS=1 it also keeps a Google Doc
// `_FOOTAGE-CHECK` in each booking box; with it off, the pages still decide
// everything and report `would-*`.
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
// v1.253 — page size (was a hard cap of 60 bookings that left most of the month
// unchecked). Each page also stops early at its own deadline, so this only sets
// how many bookings one request may try.
const pageSize = Math.max(1, parsePositiveInt(process.env.FOOTAGE_INTEGRITY_LIMIT, 60))
const docs = ['1', 'true', 'yes'].includes(String(process.env.FOOTAGE_CHECK_DOCS ?? '0').trim().toLowerCase())
const MAX_PAGES = 100
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
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/internal/footage-integrity/run`
  const headers = secret ? { 'x-footage-integrity-secret': secret } : {}
  const boxes = []
  let noBox = 0
  const noBoxCodes = []
  let failure = null
  let since = null
  let until = null
  try {
    let offset = 0
    for (let page = 1; ; page++) {
      let j
      try {
        const res = await httpRequest(`${endpoint}?days=${days}&limit=${pageSize}&offset=${offset}${docs ? '&docs=1' : ''}`, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`)
        j = JSON.parse(res.text)
      } catch (err) {
        failure = `หน้า offset=${offset} ล้ม: ${err?.message || err}`
        break
      }
      if (j.skipped) { failure = `ข้ามทั้งรอบ: ${j.reason}`; break }
      since = j.since
      until = j.until
      boxes.push(...(j.boxes || []))
      noBox += Number(j.noBox) || 0
      for (const c of j.noBoxCodes || []) if (noBoxCodes.length < 10) noBoxCodes.push(c)
      console.log(`[footage-integrity] page ${page} offset=${offset} boxes=${(j.boxes || []).length} next=${j.nextOffset} total=${j.total}`)
      if (j.nextOffset == null) break
      if (!(j.nextOffset > offset)) { failure = `หน้า offset=${offset} ไม่ขยับ (next=${j.nextOffset})`; break }
      if (page >= MAX_PAGES) { failure = `เกิน ${MAX_PAGES} หน้า — หยุดที่ offset=${j.nextOffset} จาก ${j.total}`; break }
      offset = j.nextOffset
    }
    if (failure) console.error(`[footage-integrity] run failed: ${failure}`)

    // Always send the summary — an incomplete run must say so, not go quiet.
    const res = await httpRequest(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ boxes, noBox, noBoxCodes, since, until, docs, failure }),
    })
    if (!res.ok) { console.error(`[footage-integrity] run failed: summary HTTP ${res.status}: ${res.text.slice(0, 300)}`); return }
    const s = JSON.parse(res.text)
    if (s.report && !(s.chat && s.chat.any)) console.error('[footage-integrity] run failed: summary not delivered to any chat channel')
    const count = st => boxes.filter(b => b.state === st).length
    console.log(`[footage-integrity] done boxes=${boxes.length} ok=${count('ok')} issues=${count('issues')} waiting=${count('waiting')} unreadable=${count('unreadable')} nobox=${noBox} docs=${docs ? 'on' : 'off'}${failure ? ' INCOMPLETE' : ''}`)
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

console.log(`[footage-integrity] worker started; daily at ${String(targetHourBkk).padStart(2, '0')}:00 BKK; days=${days} pageSize=${pageSize} docs=${docs ? 'on' : 'off'}; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
scheduleDaily()
