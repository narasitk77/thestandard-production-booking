// Mix-calendar repair worker — supervised by start.sh. Hourly, calls
// /api/internal/mix-calendar/sync?dryRun=0, which re-syncs the mix queue into
// its own Google Calendar (MIX_CALENDAR_ID, v1.245).
//
// v1.247 — ทำไมต้องมี: ซิงก์ปฏิทินมิกซ์เกิดแค่ inline ตอน POST/PATCH/DELETE ของ /api/mix
// ล้มแล้วเก็บ calendarSyncError ไว้บนการ์ด (เห็นแค่ Sound Admin/แอดมิน) แต่ **ไม่มีอะไรลองใหม่**
// ตั้งแต่ v1.246 แชร์ปฏิทินนี้ให้ทั้งโดเมนดู = ผู้ใช้ทั่วไปเชื่อปฏิทิน Google ว่าครบ
// งานที่ซิงก์ล้มจึงหายจากสายตาทุกคนจนกว่าจะมีคนรัน sync route ด้วยมือ
//
// ล้มต้องดัง (bug class 11 "silence is not success"): non-2xx / ok ไม่ใช่ true / failed>0 /
// timeout → console.error บรรทัดที่ BAD_RE ของ Hermes worker-check จับได้ (`] 4xx:` / `run failed`)
// ส่วนแชต ops + อีเมล digest ยิงจากฝั่ง route (worker ไม่มี notify) · worker ที่ตายหรือ 401 วน
// = ไม่มี heartbeat → dead-man ของ heartbeat.ts เตือนเองใน ~3 ชม. · `off:true` (ไม่ได้ตั้ง
// MIX_CALENDAR_ID) = ไม่มีอะไรต้องทำ เงียบ พิมพ์ครั้งเดียวต่อโปรเซส
//
// ON BY DEFAULT (idempotent: event id คำนวณจาก id งาน, เขียนแค่ปฏิทินมิกซ์ของตัวเอง)
// ปิดด้วย MIX_CALENDAR_WORKER_ENABLED=0 / false / no

const { appBaseUrl, exitDisabled } = require('./lib/env')
const { httpRequest } = require('./lib/http')

/**
 * หนึ่งรอบ → { failed, quiet?, line } · ไม่ throw (transport ล้ม/timeout = failed ไม่ใช่เงียบ)
 * แยกออกมาให้เทสยิงเซิร์ฟเวอร์ปลอมได้ (src/lib/__tests__/mix-calendar-worker.test.ts)
 */
async function syncOnce(url, headers, timeoutMs) {
  let res
  try {
    res = await httpRequest(url, { headers, timeoutMs })
  } catch (err) {
    return { failed: true, line: `run failed: ${err?.message || err}` }
  }
  if (!res.ok) return { failed: true, line: `${res.status}: ${res.text.slice(0, 500)}` }
  let j
  try {
    j = JSON.parse(res.text)
  } catch {
    return { failed: true, line: `run failed: ตอบ ${res.status} แต่อ่าน JSON ไม่ได้: ${res.text.slice(0, 200)}` }
  }
  if (j.off === true) return { failed: false, quiet: true, line: `off — ${j.note || 'MIX_CALENDAR_ID ไม่ได้ตั้ง'}` }
  const c = j.counts || {}
  const summary = `create=${c.create ?? '?'} update=${c.update ?? '?'} delete=${c.delete ?? '?'} failed=${j.failed ?? '?'}`
    + (j.truncated ? ' TRUNCATED — ชนเพดาน งานเก่าสุดไม่ถูกซิงก์รอบนี้' : '')
  // ok ต้องเป็น true จริง ๆ — body ที่ไม่มี ok ไม่ใช่หลักฐานว่าสำเร็จ (fail closed)
  if (j.ok !== true || Number(j.failed) > 0) {
    const errs = (j.results || []).filter(r => r && r.ok === false).slice(0, 5)
      .map(r => `${r.code} ${r.plan}: ${String(r.error || '').slice(0, 120)}`)
    return { failed: true, line: `run failed: ${summary}${j.error ? ` | ${j.error}` : ''}${errs.length ? ` | ${errs.join(' ; ')}` : ''}` }
  }
  return { failed: false, line: summary }
}

module.exports = { syncOnce }

if (require.main === module) {
  const flag = String(process.env.MIX_CALENDAR_WORKER_ENABLED ?? '').toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'no') {
    exitDisabled('mix-calendar', 'MIX_CALENDAR_WORKER_ENABLED')
  }

  const intervalMs = 60 * 60_000 // hourly — spec 'mix-calendar' ใน heartbeat.ts ใช้ค่าเดียวกัน
  const baseUrl = appBaseUrl()
  // route รับ NEXTAUTH_SECRET / AUTH_SECRET ตัวไหนก็ได้ (internalSecretAllowed) — ส่งตัวที่มี
  const secret = (process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '').trim()
  if (!secret) {
    console.warn('[mix-calendar] WARN: no secret (NEXTAUTH_SECRET / AUTH_SECRET) — every request will 401.')
  }
  const url = `${baseUrl}/api/internal/mix-calendar/sync?dryRun=0`
  const headers = secret ? { 'x-reconcile-secret': secret } : {}

  let running = false
  let saidOff = false
  async function runOnce() {
    if (running) return
    running = true
    try {
      const r = await syncOnce(url, headers)
      if (r.failed) console.error(`[mix-calendar] ${r.line}`)
      else if (!r.quiet) console.log(`[mix-calendar] ${r.line}`)
      else if (!saidOff) console.log(`[mix-calendar] ${r.line} (เงียบต่อจนกว่าจะเปลี่ยน)`)
      saidOff = !!r.quiet
    } finally {
      running = false
    }
  }

  let timer
  function shutdown(signal) {
    console.log(`[mix-calendar] received ${signal}, exiting`)
    if (timer) clearInterval(timer)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(`[mix-calendar] worker started; interval=${intervalMs}ms; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
  // Delay first run so Next.js finishes booting before we hit the route.
  setTimeout(runOnce, 150_000)
  timer = setInterval(runOnce, intervalMs)
}
