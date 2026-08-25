// Room-booking reconcile worker — supervised by start.sh on every container boot.
//
// v1.204 (operator: "มึงต้องเป็นคนทำเองไม่ใช่มาแจ้งให้กูไปทำ ทำ worker มาเลย")
//
// ทุกรอบมันเรียก /api/internal/room-booking/reconcile ซึ่ง:
//   - ปลดห้องที่ยังถูกยึดไว้ทั้งที่คิวถ่ายยกเลิก/ถูกลบไปแล้ว
//   - ปลดห้องที่ไม่ตรงกับห้องปัจจุบันของคิว (ย้ายห้องหลังจอง)
//   - จองห้องให้คิวที่ควรมีแต่ยังไม่มี (เมื่อ ROOM_BOOKING_ENABLED=1)
//
// ตอนนี้ service key ยังไม่มีสิทธิ์ "ยกเลิก" (ยืนยัน 2026-08-25 ได้ 401) worker
// จึงยังปลดห้องเองไม่ได้ — แต่มันจะเตือนเข้า Discord พร้อมเลข BK-#### ทุกรอบ
// และ **พอ IT เปิดสิทธิ์ให้เมื่อไร ห้องที่ค้างอยู่จะถูกเก็บกวาดเองรอบถัดไป**
// โดยไม่ต้องมีใครจำว่ามีอะไรค้าง — นั่นคือเหตุผลที่ตัวนี้มีอยู่ตั้งแต่ตอนนี้
//
// Stays dormant when ROOM_BOOKING_WORKER_ENABLED is unset / '0' / 'false'.
// Mirrors scripts/reminders-worker.js (interval, secret resolution, SIGTERM).

const { parsePositiveInt, appBaseUrl } = require('./lib/env')
const { httpRequest } = require('./lib/http')

const enabled = String(process.env.ROOM_BOOKING_WORKER_ENABLED || '').toLowerCase()
if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') {
  console.log('[room-booking] ROOM_BOOKING_WORKER_ENABLED is off — exiting (supervisor will re-launch after 5s, harmless).')
  setTimeout(() => process.exit(0), 30_000)
  return
}

const intervalMs = Math.max(
  300_000,
  parsePositiveInt(process.env.ROOM_BOOKING_WORKER_INTERVAL_MS, 60 * 60_000),
)
const days = parsePositiveInt(process.env.ROOM_BOOKING_RECONCILE_DAYS, 45)
const max = parsePositiveInt(process.env.ROOM_BOOKING_RECONCILE_MAX, 8)
const baseUrl = appBaseUrl(process.env.ROOM_BOOKING_URL)
const secret = (
  process.env.REMINDERS_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  ''
).trim()

if (!secret) {
  console.warn('[room-booking] WARN: no secret configured — every request will 401.')
}

let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/internal/room-booking/reconcile?dryRun=0&days=${days}&max=${max}`
    const res = await httpRequest(url, { headers: secret ? { 'x-room-booking-secret': secret } : {} })
    if (!res.ok) {
      console.error(`[room-booking] ${res.status}: ${res.text.slice(0, 500)}`)
      return
    }
    const j = JSON.parse(res.text)
    console.log(
      `[room-booking] scanned=${j.scanned} ปลดแล้ว=${(j.staleCancelled || []).length}` +
      ` ย้ายห้อง=${(j.wrongRoomReleased || []).length} จองใหม่=${(j.booked || []).length}` +
      ` ค้างปลดไม่ได้=${(j.staleStuck || []).length} ล้ม=${(j.failed || []).length}` +
      ((j.staleStuck || []).length ? ` | ค้าง: ${j.staleStuck.map(s => s.bookingNo).join(',')}` : ''),
    )
  } catch (err) {
    console.error('[room-booking] run failed:', err?.message || err)
  } finally {
    running = false
  }
}

let timer
function shutdown(signal) {
  console.log(`[room-booking] received ${signal}, exiting`)
  if (timer) clearInterval(timer)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log(`[room-booking] worker started; interval=${intervalMs}ms; days=${days}; max=${max}; baseUrl=${baseUrl}; secret=${secret ? 'set' : 'MISSING'}`)
setTimeout(runOnce, 90_000)
timer = setInterval(runOnce, intervalMs)
