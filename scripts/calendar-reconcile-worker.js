const intervalMs = Math.max(
  60_000,
  Number(process.env.CALENDAR_RECONCILE_INTERVAL_MS || 10 * 60_000),
)
const baseUrl = process.env.CALENDAR_RECONCILE_URL || 'http://127.0.0.1:3000'
const secret = (
  process.env.CALENDAR_RECONCILE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/calendar/reconcile?limit=50`
    const res = await fetch(url, {
      headers: secret ? { 'x-reconcile-secret': secret } : {},
    })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[calendar-reconcile] ${res.status}: ${body.slice(0, 500)}`)
      return
    }
    const json = JSON.parse(body)
    const changed = (json.patched || 0) + (json.created || 0) + (json.failed || 0)
    if (changed > 0) {
      console.log(
        `[calendar-reconcile] checked=${json.checked} ok=${json.ok} patched=${json.patched} created=${json.created} failed=${json.failed}`,
      )
    }
  } catch (err) {
    console.error('[calendar-reconcile] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

console.log(`[calendar-reconcile] worker started; interval=${intervalMs}ms`)
setTimeout(runOnce, 30_000)
setInterval(runOnce, intervalMs)
