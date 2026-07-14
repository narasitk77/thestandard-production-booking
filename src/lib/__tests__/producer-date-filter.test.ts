/**
 * v1.147 — /producer date-filter logic (matchesDateFilter + helpers are
 * exported from the client component; pure string/date math, no React).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesDateFilter, addDaysStr, bangkokTodayStr } from '../../app/producer/ProducerDashboard'

const today = bangkokTodayStr()
const bk = (shootDate: string, shootEndDate?: string | null) => ({ shootDate, shootEndDate }) as any

test('all: matches everything', () => {
  assert.equal(matchesDateFilter(bk('2020-01-01'), 'all', ''), true)
})

test('today: single-day shoot today matches; yesterday/tomorrow do not', () => {
  assert.equal(matchesDateFilter(bk(today), 'today', ''), true)
  assert.equal(matchesDateFilter(bk(addDaysStr(today, -1)), 'today', ''), false)
  assert.equal(matchesDateFilter(bk(addDaysStr(today, 1)), 'today', ''), false)
})

test('today: multi-day shoot SPANNING today matches (started yesterday, ends tomorrow)', () => {
  assert.equal(matchesDateFilter(bk(addDaysStr(today, -1), addDaysStr(today, 1)), 'today', ''), true)
})

test('tomorrow: matches shoots on (or spanning) tomorrow only', () => {
  assert.equal(matchesDateFilter(bk(addDaysStr(today, 1)), 'tomorrow', ''), true)
  assert.equal(matchesDateFilter(bk(today), 'tomorrow', ''), false)
  assert.equal(matchesDateFilter(bk(today, addDaysStr(today, 3)), 'tomorrow', ''), true) // spans tomorrow
})

test('week: next-7-days window, overlap semantics', () => {
  assert.equal(matchesDateFilter(bk(addDaysStr(today, 7)), 'week', ''), true)   // edge of window
  assert.equal(matchesDateFilter(bk(addDaysStr(today, 8)), 'week', ''), false)  // beyond
  assert.equal(matchesDateFilter(bk(addDaysStr(today, -1)), 'week', ''), false) // already ended
  assert.equal(matchesDateFilter(bk(addDaysStr(today, -2), addDaysStr(today, 2)), 'week', ''), true) // ongoing multi-day
})

test('date: exact picked day incl. mid-multi-day; empty picker matches all', () => {
  assert.equal(matchesDateFilter(bk('2026-07-20'), 'date', '2026-07-20'), true)
  assert.equal(matchesDateFilter(bk('2026-07-20'), 'date', '2026-07-21'), false)
  assert.equal(matchesDateFilter(bk('2026-07-20', '2026-07-25'), 'date', '2026-07-22'), true)
  assert.equal(matchesDateFilter(bk('2026-07-20'), 'date', ''), true)
})

test('ISO datetime strings from the API (UTC midnight) compare correctly', () => {
  assert.equal(matchesDateFilter(bk('2026-07-20T00:00:00.000Z', '2026-07-25T00:00:00.000Z'), 'date', '2026-07-22'), true)
})

test('addDaysStr crosses month/year boundaries', () => {
  assert.equal(addDaysStr('2026-12-30', 3), '2027-01-02')
  assert.equal(addDaysStr('2026-03-01', -1), '2026-02-28')
})
