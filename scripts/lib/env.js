// Shared helpers for the supervised worker scripts (CommonJS — run by start.sh).

// Parse a numeric env var safely. `Number('abc')` is NaN, and `setInterval(fn,
// NaN)` is silently clamped to ~1ms — i.e. a busy loop that hammers the API and
// the DB. Guard against that by falling back to the default whenever the value
// isn't a finite, positive number.
function parsePositiveInt(envValue, fallback) {
  if (envValue == null || envValue === '') return fallback
  const n = Number(envValue)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// v1.168 — where the worker should send its request.
//
// Every supervised worker is a THIN SCHEDULER: it sleeps until its hour, then
// calls one `/api/internal/...` endpoint on the app. Nothing here touches
// Postgres or Drive. That is what makes the workers relocatable — point them at
// a different app and they keep working unchanged.
//
// Resolution order, most specific first:
//   1. the worker's own URL var (VIDEO_MERGE_URL, LANDING_MANAGE_URL, …) —
//      still honoured so a single worker can be pointed somewhere special
//   2. WORKER_APP_URL — set once when the workers run in their OWN container,
//      e.g. http://app:3000 inside the compose network
//   3. 127.0.0.1:3000 — the historical default, i.e. "same container as the app"
//
// Prefer the in-network service name over the public URL: the reverse proxy
// times out long Drive-mutating endpoints at ~60s (the recurring 504), while a
// direct container-to-container call has no such limit.
function appBaseUrl(specificEnvValue) {
  const pick = (specificEnvValue || '').trim()
    || (process.env.WORKER_APP_URL || '').trim()
    || 'http://127.0.0.1:3000'
  return pick.replace(/\/+$/, '')
}

/**
 * v1.238 — รหัสออกที่แปลว่า "worker ตัวนี้ถูกปิดไว้" (78 = EX_CONFIG ของ sysexits)
 *
 * WHY. เดิม worker ที่ถูกปิดจะพิมพ์ว่าปิดอยู่ แล้ว `setTimeout(exit, 30_000)`
 * ค้างไว้ 30 วินาทีเพื่อ *ชะลอ* ไม่ให้ supervisor ปลุกถี่เกินไป จากนั้น supervisor
 * sleep อีก 5 วินาทีแล้วปลุกใหม่ = วนทุก ~35 วินาทีตลอดอายุคอนเทนเนอร์
 * วัดจริงบนพรอด 2026-09-25: worker ที่ปิดอยู่ 2 ตัวผลิต **6,654 จาก 6,898 บรรทัด
 * (96%) ใน 16 ชั่วโมง** — log กลายเป็นที่ที่หา error จริงไม่เจอ
 * (ตอนไล่เหตุการณ์จริง grep คำว่า 429 ได้ 46 ครั้งซึ่งเป็นเลขในไทม์สแตมป์ล้วน ๆ)
 *
 * เหตุผลเดิมของการปลุกซ้ำคือ "จะได้สลับ env ใน Portainer แล้วติดเลย" — **ซึ่งเป็นไปไม่ได้**
 * env ของคอนเทนเนอร์ที่รันอยู่แก้ไม่ได้ (Docker ไม่มี API ให้ทำ) การอัปเดต stack
 * ใน Portainer คือการ **สร้างคอนเทนเนอร์ใหม่** ซึ่ง worker ก็อ่านค่าใหม่ตอน
 * launch แรกอยู่แล้ว ⇒ การปลุกซ้ำไม่เคยเปลี่ยนอะไรได้เลยสักครั้ง
 *
 * supervisor จึงหยุดปลุกเมื่อเจอรหัสนี้ (ดู `supervise()` ใน start.sh)
 * ถ้าวันหนึ่งพิสูจน์ได้ว่า env เปลี่ยนได้จริงระหว่างที่คอนเทนเนอร์ยังอยู่
 * ให้เปลี่ยน `break` ใน supervise() เป็น `sleep` ยาว ๆ — บรรทัดเดียว
 */
const EXIT_DISABLED = 78

/** ปิดอยู่: พิมพ์เหตุผลหนึ่งบรรทัดแล้วออกด้วยรหัสที่ supervisor เข้าใจ */
function exitDisabled(label, envName) {
  console.log(`[${label}] ${envName} ปิดอยู่ — ไม่สตาร์ต (supervisor จะหยุดปลุก · เปิดได้โดยตั้งค่าแล้ว redeploy)`)
  process.exit(EXIT_DISABLED)
}

module.exports = { parsePositiveInt, appBaseUrl, EXIT_DISABLED, exitDisabled }
