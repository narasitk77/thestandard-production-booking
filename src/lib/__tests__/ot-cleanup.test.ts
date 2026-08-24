/**
 * weekly-audit 2026-06-29 — the editable-month gate must use the Bangkok month,
 * not the server-UTC month. During the first ~7h of each Bangkok month the UTC
 * clock is still in the previous month; deriving "current month" from UTC wrongly
 * rejected same-day OT entry/edit as a "closed month".
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { currentMonthYYYYMM, isMonthEditable } from '../ot-cleanup'

test('currentMonthYYYYMM uses the Bangkok month at the UTC month-rollover gap', () => {
  // 2026-07-31 20:00 UTC === 2026-08-01 03:00 Asia/Bangkok (UTC+7).
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-31T20:00:00Z').getTime() })
  try {
    assert.equal(currentMonthYYYYMM(), '2026-08') // Bangkok month, not UTC '2026-07'
    assert.equal(isMonthEditable('2026-08'), true)
    assert.equal(isMonthEditable('2026-07'), false)
  } finally {
    mock.timers.reset()
  }
})

// ── v1.192 — cleanup ต้องลบเฉพาะเดือนที่ "เก่ากว่า" ไม่ใช่ "ไม่ใช่เดือนนี้" ──
//
// ของจริงที่เสียไป 2026-08-24: เดิมใช้ `month: { notIn: keep }` ซึ่งลบเดือนอนาคตด้วย
// ร่าง OT ถูกสร้างจากคิวถ่ายซึ่งส่วนใหญ่เป็นวันในอนาคต → ทุกครั้งที่ใครเปิดหน้า /ot
// (cleanup รันแบบ lazy ที่ GET /api/ot) ร่างเดือนถัดไปถูกลบทิ้งเงียบ ๆ
// วันนั้นเปิดหน้าเพื่อทดสอบเรื่องอื่น แล้วร่างเดือน ก.ย. 33 ใบหายทันที ซึ่งเป็น
// เดือนที่ pilot จะใช้พอดี — กฏนี้ไม่เคยถูกเทสมาก่อน
import { otCleanupCutoff } from '../ot-cleanup'

const keeps = (today: string, month: string) => month >= otCleanupCutoff(today)

test('หลังวันที่ 10: เก็บเดือนปัจจุบัน ลบเดือนก่อนหน้า', () => {
  assert.equal(otCleanupCutoff('2026-08-24'), '2026-08')
  assert.equal(keeps('2026-08-24', '2026-08'), true)
  assert.equal(keeps('2026-08-24', '2026-07'), false)
  assert.equal(keeps('2026-08-24', '2026-01'), false)
})

test('ภายในวันที่ 10: ผ่อนผันให้เดือนก่อนหน้าอยู่ต่อ', () => {
  assert.equal(otCleanupCutoff('2026-08-05'), '2026-07')
  assert.equal(keeps('2026-08-05', '2026-07'), true)
  assert.equal(keeps('2026-08-05', '2026-06'), false)
})

test('**เดือนอนาคตต้องไม่ถูกลบ** — นี่คือบั๊กที่ทำข้อมูลหายจริง', () => {
  for (const today of ['2026-08-24', '2026-08-05']) {
    for (const future of ['2026-09', '2026-10', '2026-12', '2027-01']) {
      assert.equal(keeps(today, future), true, `${today} ต้องเก็บ ${future}`)
    }
  }
})

test('ข้ามปีต้องเทียบถูก (เทียบสตริง YYYY-MM ที่ zero-padded)', () => {
  assert.equal(otCleanupCutoff('2027-01-15'), '2027-01')
  assert.equal(keeps('2027-01-15', '2026-12'), false, 'ธ.ค. ปีก่อนคือของเก่า')
  assert.equal(otCleanupCutoff('2027-01-05'), '2026-12')
  assert.equal(keeps('2027-01-05', '2026-12'), true, 'ในช่วงผ่อนผันยังเก็บ ธ.ค.')
  assert.equal(keeps('2027-01-05', '2026-11'), false)
})

test('เดือนเลขหลักเดียวต้อง zero-pad ไม่งั้นเทียบสตริงเพี้ยน', () => {
  assert.equal(otCleanupCutoff('2026-09-15'), '2026-09')
  assert.equal(keeps('2026-09-15', '2026-10'), true)
  // ถ้าไม่ pad จะได้ '2026-9' ซึ่ง > '2026-10' ตามลำดับสตริง = ลบ ต.ค. ทิ้ง
  assert.equal(otCleanupCutoff('2026-09-15').length, 7)
})
