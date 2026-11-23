// v1.266.1 — scripts/reminders-worker.js ยิงตามนาฬิกา ไม่ใช่ตามการบูต
//
// เดิมยิง 60 วิหลังบูตทุกครั้ง แล้วนับ 24 ชม. ต่อจากนั้น → deploy = ตารางเวลา: เมล "⏰ เตือนงานค้าง"
// ทั้ง 6 ฉบับของ 9–11 ต.ค. 2569 ออกตอน deploy (11 ต.ค. สองฉบับ) และเมลเตือน QU ถึง Producer ก็ออกตามนาฬิกามั่วนั้น
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { msUntilNextRun, quLogPart } = require_('../../../scripts/reminders-worker.js') as {
  msUntilNextRun: (now?: Date, hourBkk?: number) => number
  quLogPart: (q: unknown) => string
}
const MIN = 60_000

test('deploy ตอน 22:05 (เคส 11 ต.ค.) → รอถึง 09:00 พรุ่งนี้ ไม่ยิงตอนบูต', () => {
  const at = new Date('2026-10-11T15:05:00Z') // 22:05 BKK
  assert.equal(msUntilNextRun(at, 9), (10 * 60 + 55) * MIN)
})

test('ก่อน 09:00 → วันนี้ · ตรง 09:00 พอดีหรือเลยไปแล้ว → พรุ่งนี้ (ไม่ยิงซ้ำในวันเดียว)', () => {
  assert.equal(msUntilNextRun(new Date('2026-10-12T01:59:00Z'), 9), 1 * MIN) // 08:59 BKK
  assert.equal(msUntilNextRun(new Date('2026-10-12T02:00:00Z'), 9), 24 * 60 * MIN) // 09:00 BKK
  assert.equal(msUntilNextRun(new Date('2026-10-12T02:00:01Z'), 9), 24 * 60 * MIN - 1000)
})

test('ข้ามวันตาม UTC ถูก: ชั่วโมง BKK ที่ยังเป็นเมื่อวานใน UTC', () => {
  // 06:00 BKK = 23:00Z of the previous UTC day
  assert.equal(msUntilNextRun(new Date('2026-10-11T22:30:00Z'), 6), 30 * MIN) // 05:30 BKK → 06:00
  assert.equal(msUntilNextRun(new Date('2026-10-11T23:30:00Z'), 6), (23 * 60 + 30) * MIN) // 06:30 BKK → tomorrow
})

test('ไม่มีเวลาไหนของวันที่การบูตทำให้ยิงภายใน 1 นาทีแรก ยกเว้นบูตก่อนเวลานัดไม่ถึงนาที', () => {
  let short = 0
  for (let m = 0; m < 24 * 60; m++) {
    const at = new Date(Date.UTC(2026, 9, 11, 0, m))
    if (msUntilNextRun(at, 9) <= MIN) short++
  }
  assert.equal(short, 1, 'มีแค่นาทีเดียวต่อวัน (08:59 BKK) — ไม่ใช่ทุกครั้งที่ deploy')
})

// รอบ 2 (23 พ.ย.) — log ต้องบอกจำนวนใบที่ไม่มีใครถูกตาม ไม่ใช่แค่ pending/emailed/failed
test('บรรทัด log ของ QU นับ noProducerEmail / producerInactive ด้วย', () => {
  const line = quLogPart({
    pending: 20, emailed: 3, failed: 0, skipped: false, producersDue: 3,
    noProducerEmail: ['AGN-1', 'AGN-2'],
    producerInactive: [{ producerEmail: 'phantawat.s@thestandard.co', bookingCodes: ['POD-8MH-260814-01'] }],
  })
  assert.equal(line, ' | qu: pending=20 emailed=3 failed=0 noProducerEmail=2 producerInactive=1')
  // sweep ล้ม → ยังบอก ERROR เหมือนเดิม ไม่พังเพราะไม่มีลิสต์
  assert.equal(quLogPart({ error: 'boom' }),
    ' | qu: pending=undefined emailed=undefined failed=undefined noProducerEmail=undefined producerInactive=undefined ERROR=boom')
  assert.match(quLogPart(undefined), /pending=undefined/)
})
