/**
 * generateRoutineDates — the pure date engine behind the Routine planner.
 * The riskiest logic in v1.56 (weekday mapping, inclusive bounds, skip
 * precedence, span cap, month/year boundaries), so it gets direct coverage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRoutineDates, ROUTINE_MAX_DAYS } from '../routine'

const MON_FRI = [1, 2, 3, 4, 5]

test('Mon–Fri over a single week yields exactly the 5 weekdays, inclusive', () => {
  // 2026-06-15 is a Monday; 2026-06-19 a Friday
  const r = generateRoutineDates({ startDate: '2026-06-15', endDate: '2026-06-19', weekdays: MON_FRI, skipHolidays: false })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.dates, ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19'])
})

test('weekend days are excluded entirely (not reported as skipped)', () => {
  // full week incl. Sat 20 + Sun 21
  const r = generateRoutineDates({ startDate: '2026-06-15', endDate: '2026-06-21', weekdays: MON_FRI, skipHolidays: false })
  assert.equal(r.dates.length, 5)
  assert.equal(r.skipped.length, 0) // Sat/Sun are outside the pattern, not "skipped"
})

test('weekday mapping: 0=Sun, 1=Mon … 6=Sat', () => {
  // only Sundays in this week → 2026-06-21 is the Sunday
  const r = generateRoutineDates({ startDate: '2026-06-15', endDate: '2026-06-21', weekdays: [0], skipHolidays: false })
  assert.deepEqual(r.dates, ['2026-06-21'])
})

test('Thai holidays are skipped with a reason+label when skipHolidays=true', () => {
  // July 2026 has King Rama X birthday (28), Asarnha Bucha (29), Khao Phansa (30)
  const r = generateRoutineDates({ startDate: '2026-07-27', endDate: '2026-07-31', weekdays: MON_FRI, skipHolidays: true })
  assert.ok(!r.dates.includes('2026-07-28'))
  assert.ok(!r.dates.includes('2026-07-29'))
  assert.ok(!r.dates.includes('2026-07-30'))
  assert.ok(r.dates.includes('2026-07-27'))
  assert.ok(r.dates.includes('2026-07-31'))
  const holiday = r.skipped.find(s => s.date === '2026-07-28')
  assert.equal(holiday?.reason, 'holiday')
  assert.ok(holiday?.label)
})

test('holidays are NOT skipped when skipHolidays=false', () => {
  const r = generateRoutineDates({ startDate: '2026-07-28', endDate: '2026-07-28', weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false })
  assert.deepEqual(r.dates, ['2026-07-28'])
})

test('custom skip wins, and a date both holiday+custom reports as custom', () => {
  const r = generateRoutineDates({
    startDate: '2026-07-27', endDate: '2026-07-31', weekdays: MON_FRI,
    skipHolidays: true, customSkip: ['2026-07-27', '2026-07-28'],
  })
  assert.ok(!r.dates.includes('2026-07-27'))
  assert.equal(r.skipped.find(s => s.date === '2026-07-27')?.reason, 'custom')
  // 28 is both a holiday and custom-skip → custom takes precedence in reporting
  assert.equal(r.skipped.find(s => s.date === '2026-07-28')?.reason, 'custom')
})

test('crosses month and year boundaries correctly', () => {
  // Mon 2026-12-28 … Mon 2027-01-04
  const r = generateRoutineDates({ startDate: '2026-12-28', endDate: '2027-01-04', weekdays: MON_FRI, skipHolidays: false })
  assert.ok(r.dates.includes('2026-12-31'))
  assert.ok(r.dates.includes('2027-01-01'))
  assert.ok(r.dates.includes('2027-01-04'))
  assert.ok(!r.dates.includes('2027-01-02')) // Saturday
})

test('empty weekdays → error', () => {
  const r = generateRoutineDates({ startDate: '2026-06-15', endDate: '2026-06-19', weekdays: [], skipHolidays: false })
  assert.ok(r.error)
  assert.equal(r.dates.length, 0)
})

test('end before start → error', () => {
  const r = generateRoutineDates({ startDate: '2026-06-19', endDate: '2026-06-15', weekdays: MON_FRI, skipHolidays: false })
  assert.ok(r.error)
})

test('invalid date string → error, no throw', () => {
  const r = generateRoutineDates({ startDate: 'nope', endDate: '2026-06-19', weekdays: MON_FRI, skipHolidays: false })
  assert.ok(r.error)
})

test('span longer than the cap → error', () => {
  // 2026-01-01 .. 2027-12-31 is well over ROUTINE_MAX_DAYS calendar days
  const r = generateRoutineDates({ startDate: '2026-01-01', endDate: '2027-12-31', weekdays: MON_FRI, skipHolidays: false })
  assert.ok(r.error)
  assert.ok(String(r.error).includes(String(ROUTINE_MAX_DAYS)))
})

test('a full non-leap year (365 days, within the cap) is allowed', () => {
  // 2026 is not a leap year → 2026-01-01..2026-12-31 inclusive = 365 days,
  // which is ≤ ROUTINE_MAX_DAYS (366), so it generates without error.
  const r = generateRoutineDates({ startDate: '2026-01-01', endDate: '2026-12-31', weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false })
  assert.equal(r.error, undefined)
  assert.equal(r.dates.length, 365)
})
