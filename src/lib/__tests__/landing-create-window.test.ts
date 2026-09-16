/**
 * Landing drop-folder CREATE WINDOW (v1.222).
 *
 * The bug this locks out: the nightly sweep created folders for TOMORROW ONLY,
 * and the approve-time hook (`shootIsImminentBkk`) covered today+tomorrow only.
 * A booking approved 2+ days before its shoot therefore got no drop folder
 * until 19:00 the evening before — so for most of every working day the NAS
 * share had nothing prepared for upcoming shoots and crew hit an empty folder.
 *
 * The two horizons MUST move together. If the sweep pre-creates 3 days ahead
 * but the approve hook still only fires for tomorrow, the hole just moves to
 * "approved late for a shoot 3 days out" instead of closing. That coupling is
 * the whole point of these tests — not the arithmetic.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { shootIsImminentBkk } from '../landing-lifecycle'

/** UTC midnight of a BKK calendar date — the shape Booking.shootDate is stored in. */
function bkkDay(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

// 2026-09-16 14:15 BKK = 07:15 UTC — the exact situation that was reported:
// early afternoon, tomorrow's shoots approved days ago, drop zone empty.
const NOW = new Date('2026-09-16T07:15:00.000Z')

const original = process.env.LANDING_CREATE_DAYS
beforeEach(() => { delete process.env.LANDING_CREATE_DAYS })
afterEach(() => {
  if (original === undefined) delete process.env.LANDING_CREATE_DAYS
  else process.env.LANDING_CREATE_DAYS = original
})

test('default (unset) keeps the historical today+tomorrow horizon', () => {
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-16'), NOW), true, 'today')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-17'), NOW), true, 'tomorrow')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-18'), NOW), false, 'day after — outside the old window')
})

test('LANDING_CREATE_DAYS=3 extends the approve-time hook to match the sweep', () => {
  process.env.LANDING_CREATE_DAYS = '3'
  for (const d of ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']) {
    assert.equal(shootIsImminentBkk(bkkDay(d), NOW), true, `${d} must be covered`)
  }
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-20'), NOW), false, 'day 4 is beyond a 3-day window')
})

test('yesterday is never imminent — the sweep must not resurrect past folders', () => {
  process.env.LANDING_CREATE_DAYS = '14'
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-15'), NOW), false)
})

test('a garbage or hostile LANDING_CREATE_DAYS cannot widen or invert the window', () => {
  // A typo must degrade to the safe default, never sweep the whole year and
  // never produce an empty window that silently creates nothing.
  for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
    process.env.LANDING_CREATE_DAYS = bad
    assert.equal(shootIsImminentBkk(bkkDay('2026-09-17'), NOW), true, `${bad}: tomorrow still covered`)
    assert.equal(shootIsImminentBkk(bkkDay('2026-09-18'), NOW), false, `${bad}: must not widen`)
  }
  process.env.LANDING_CREATE_DAYS = '9999'
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-29'), NOW), true, 'capped at 14 days, so day 13 is in')
  assert.equal(shootIsImminentBkk(bkkDay('2026-10-01'), NOW), false, 'capped at 14 days, so day 15 is out')
})

test('fractional values floor instead of throwing off the day boundary', () => {
  process.env.LANDING_CREATE_DAYS = '2.9'
  // window = [offset .. offset + days - 1] = [+1 .. +2] → the 17th and 18th
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-18'), NOW), true)
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-19'), NOW), false, '2.9 floors to 2, not 3')
})

test('the horizon is measured in BKK days, not UTC days', () => {
  process.env.LANDING_CREATE_DAYS = '1'
  // 2026-09-16 23:30 BKK = 16:30 UTC. Still the 16th in Bangkok, so the
  // window is 16→17. Reading this as a UTC date would slide it a day.
  const lateEvening = new Date('2026-09-16T16:30:00.000Z')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-17'), lateEvening), true)
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-18'), lateEvening), false)

  // 2026-09-17 00:30 BKK = 2026-09-16 17:30 UTC — already the 17th in Bangkok.
  const justAfterMidnight = new Date('2026-09-16T17:30:00.000Z')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-17'), justAfterMidnight), true, 'now "today"')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-18'), justAfterMidnight), true, 'now "tomorrow"')
  assert.equal(shootIsImminentBkk(bkkDay('2026-09-16'), justAfterMidnight), false, 'now yesterday')
})
