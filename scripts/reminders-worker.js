// Reminder worker — supervised by start.sh on every container boot. Polls the
// in-process /api/internal/reminders/run endpoint once per interval (daily by
// default), which runs the scan + dispatch (Discord + email digest).
//
// v1.266.1 — anchored to a BKK clock hour (REMINDERS_HOUR, default 09), like the
// other daily workers. It used to fire 60 s after every boot and then every 24 h
// from there, so a deploy WAS the schedule: all six "⏰ เตือนงานค้าง" digests of
// 9–11 Oct 2026 went out at deploy times (two on 11 Oct), and the producers' QU
// reminders rode the same random clock. A boot no longer sends anything.
//
// Stays dormant when REMINDERS_WORKER_ENABLED is unset / '0' / 'false' — the
// supervisor loop still restarts this script every 5s, so flipping the env var
// live in Portainer and restarting the stack turns it on without a code change.
//
// Mirrors scripts/footage-sheet-sync-worker.js (interval, secret resolution,
// SIGTERM handling) so anyone who's debugged that one knows the shape of this.

const { parsePositiveInt, appBaseUrl, exitDisabled } = require('./lib/env')
const { httpRequest } = require('./lib/http')

// Run as a worker only when started as one — a test requires this file for msUntilNextRun.
const isMain = require.main === module
const enabled = String(process.env.REMINDERS_WORKER_ENABLED || '').toLowerCase()
if (isMain && enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  exitDisabled('reminders', 'REMINDERS_WORKER_ENABLED')
}

const intervalMs = Math.max(
  60_000,
  parsePositiveInt(process.env.REMINDERS_WORKER_INTERVAL_MS, 24 * 60 * 60_000),
)
const targetHourBkk = Math.min(23, Math.max(0, parsePositiveInt(process.env.REMINDERS_HOUR, 9)))
const baseUrl = appBaseUrl(process.env.REMINDERS_URL)
const secret = (
  process.env.REMINDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (isMain && !secret) {
  console.warn(
    '[reminders] WARN: no secret configured (REMINDERS_SECRET / NEXTAUTH_SECRET / AUTH_SECRET). Worker will keep polling but every request will 401.',
  )
}

// Same as footage-integrity-worker / lark-export-worker: the next HH:00 in Bangkok (UTC+7, no DST).
function msUntilNextRun(now = new Date(), hourBkk = targetHourBkk) {
  const targetUtcHour = (hourBkk - 7 + 24) % 24
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/reminders/run`
    const res = await httpRequest(url, {
      headers: secret ? { 'x-reminders-secret': secret } : {},
    })
    const text = res.text
    if (!res.ok) {
      console.error(`[reminders] ${res.status}: ${text.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(text)
    console.log(
      "[reminders] detected=" + json.detected + " created=" + json.created + " resolved=" + json.resolved +
        " open=" + json.openCount + " discord=" + (json.dispatched && json.dispatched.discord) +
        " lark=" + (json.dispatched && json.dispatched.lark) +
        " email=" + (json.dispatched && json.dispatched.email) +
        // v1.187 — งานเตือนเลข QU ต้องมีร่องรอยใน log ไม่งั้นล้มแล้วไม่มีใครรู้
        " | qu: pending=" + (json.quReminder && json.quReminder.pending) +
        " emailed=" + (json.quReminder && json.quReminder.emailed) +
        " failed=" + (json.quReminder && json.quReminder.failed) +
        (json.quReminder && json.quReminder.error ? " ERROR=" + json.quReminder.error : ""),
    )
  } catch (err) {
    console.error('[reminders] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

module.exports = { msUntilNextRun }

let timer
function shutdown(signal) {
  console.log(`[reminders] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
if (isMain) {
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(
    `[reminders] worker started; first run ~${String(targetHourBkk).padStart(2, '0')}:00 BKK, then every ${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`,
  )
  const wait = msUntilNextRun()
  console.log(`[reminders] next run in ${Math.round(wait / 60000)} min`)
  setTimeout(async () => { await runOnce(); timer = setInterval(runOnce, intervalMs) }, wait)
}
