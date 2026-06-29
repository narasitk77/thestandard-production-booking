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
