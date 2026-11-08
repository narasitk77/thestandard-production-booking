// maint 2026-11-08 (B2a) — overnight single-day shoots.
//
// A wizard booking for 20 Nov has shootEndDate = shootDate; an admin edits the
// times to 20:00 → 02:00. isShootOver had no callTime, so at 02:00 on the 20th
// ('02:00' >= '02:00' on the "last day") the next GET /api/bookings auto-
// COMPLETED it ~18 h before the call — after which it can't be cancelled. And
// computeEventTimes rolled the end only when shootEndDate was null, so the event
// had end < start and Google rejected it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isShootOver, wrapsNextDay } from '../shoot-window'
import { computeEventTimes } from '../google-calendar'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
const bkk = (iso: string) => new Date(`${iso}+07:00`) // a Bangkok wall-clock instant

const overnight = { shootDate: day('2026-11-20'), shootEndDate: day('2026-11-20'), callTime: '20:00', estimatedWrap: '02:00' }

test('THE BUG: 02:00 on the shoot day itself, before the 20:00 call → NOT over', () => {
  assert.equal(isShootOver(overnight, bkk('2026-11-20T02:00:00')), false)
  assert.equal(isShootOver(overnight, bkk('2026-11-20T23:30:00')), false, 'mid-shoot')
})

test('overnight shoot is over at the wrap on the NEXT day, not before', () => {
  assert.equal(isShootOver(overnight, bkk('2026-11-21T01:59:00')), false, 'still shooting past midnight')
  assert.equal(isShootOver(overnight, bkk('2026-11-21T02:00:00')), true)
  assert.equal(isShootOver(overnight, bkk('2026-11-22T00:30:00')), true)
})

test('same overnight shape with shootEndDate null (MCP / routine bookings)', () => {
  const b = { ...overnight, shootEndDate: null }
  assert.equal(isShootOver(b, bkk('2026-11-20T03:00:00')), false)
  assert.equal(isShootOver(b, bkk('2026-11-21T03:00:00')), true)
})

test('callers that do not pass callTime keep the old same-day reading', () => {
  const { callTime: _drop, ...noCall } = overnight
  assert.equal(isShootOver(noCall, bkk('2026-11-20T02:00:00')), true)
})

test('daytime and real multi-day shoots are unchanged', () => {
  const daytime = { shootDate: day('2026-11-20'), shootEndDate: day('2026-11-20'), callTime: '09:00', estimatedWrap: '18:00' }
  assert.equal(isShootOver(daytime, bkk('2026-11-20T17:59:00')), false)
  assert.equal(isShootOver(daytime, bkk('2026-11-20T18:00:00')), true)
  const trip = { shootDate: day('2026-11-20'), shootEndDate: day('2026-11-22'), callTime: '22:00', estimatedWrap: '09:00' }
  assert.equal(wrapsNextDay(trip), false, 'a real end date is the wrap date')
  assert.equal(isShootOver(trip, bkk('2026-11-22T08:59:00')), false)
  assert.equal(isShootOver(trip, bkk('2026-11-22T09:00:00')), true)
})

test('calendar event: shootEndDate == shootDate + wrap ≤ call rolls the end to the next day', () => {
  const { startTime, endTime } = computeEventTimes({ shootDate: '2026-11-20', shootEndDate: '2026-11-20', callTime: '20:00', estimatedWrap: '02:00' })
  assert.equal(startTime, '2026-11-20T20:00:00+07:00')
  assert.equal(endTime, '2026-11-21T02:00:00+07:00')
  assert.ok(new Date(endTime) > new Date(startTime), 'Google rejects an empty/negative range')
})
