/**
 * maint 2026-11-08 (B5-ui) — src/lib/booking-list.ts: the client reader of
 * GET /api/bookings (error ≠ empty, truncated is surfaced) + the span rule.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchBookingList, addDaysStr, bookingCoversDay, bookingOverlapsRange, bookingDayKeys, mondayOf, heldMinutesOnDay,
} from '../booking-list'

const res = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch

test('fetchBookingList: a 401/500 JSON error THROWS — never resolves to an empty list (ui-6)', async () => {
  await assert.rejects(fetchBookingList({}, res(401, JSON.stringify({ error: 'Unauthorized' }))), /Unauthorized \(HTTP 401\)/)
  await assert.rejects(fetchBookingList({}, res(500, JSON.stringify({ error: 'Failed to fetch bookings' }))), /HTTP 500/)
})

test('fetchBookingList: a 502 HTML proxy page throws with the status', async () => {
  await assert.rejects(fetchBookingList({}, res(502, '<html>Bad Gateway</html>')), /HTTP 502/)
})

test('fetchBookingList: 200 without a bookings array is a failure, not []', async () => {
  await assert.rejects(fetchBookingList({}, res(200, JSON.stringify({ ok: true }))), /HTTP 200/)
})

test('fetchBookingList: passes params through and reports truncated from the API flag', async () => {
  let url = ''
  const f = (async (u: string) => { url = u; return new Response(JSON.stringify({ bookings: [{ id: 'a' }], total: 7, truncated: true })) }) as unknown as typeof fetch
  const r = await fetchBookingList({ from: '2026-11-08', span: '1', order: 'asc' }, f)
  assert.match(url, /^\/api\/bookings\?from=2026-11-08&span=1&order=asc$/)
  assert.deepEqual(r, { bookings: [{ id: 'a' }], total: 7, truncated: true })
})

test('fetchBookingList: an older server without the flag → truncated from total vs rows', async () => {
  const r = await fetchBookingList({}, res(200, JSON.stringify({ bookings: [{ id: 'a' }, { id: 'b' }], total: 5 })))
  assert.equal(r.truncated, true)
  const r2 = await fetchBookingList({}, res(200, JSON.stringify({ bookings: [{ id: 'a' }], total: 1 })))
  assert.equal(r2.truncated, false)
})

const bk = (shootDate: string, shootEndDate?: string | null) => ({ shootDate: `${shootDate}T00:00:00.000Z`, shootEndDate: shootEndDate ? `${shootEndDate}T00:00:00.000Z` : shootEndDate })

test('bookingCoversDay: day 2 and 3 of a 10–12 Nov shoot are occupied (ui-5)', () => {
  const b = bk('2026-11-10', '2026-11-12')
  for (const d of ['2026-11-10', '2026-11-11', '2026-11-12']) assert.equal(bookingCoversDay(b, d), true, d)
  assert.equal(bookingCoversDay(b, '2026-11-09'), false)
  assert.equal(bookingCoversDay(b, '2026-11-13'), false)
})

test('bookingCoversDay: single-day unchanged; end before start = single day (bad data)', () => {
  assert.equal(bookingCoversDay(bk('2026-11-10'), '2026-11-10'), true)
  assert.equal(bookingCoversDay(bk('2026-11-10'), '2026-11-11'), false)
  assert.equal(bookingCoversDay(bk('2026-11-10', '2026-11-01'), '2026-11-05'), false)
})

test('bookingOverlapsRange: half-open [from, to)', () => {
  assert.equal(bookingOverlapsRange(bk('2026-11-06', '2026-11-09'), '2026-11-09', '2026-11-16'), true) // ends on Monday
  assert.equal(bookingOverlapsRange(bk('2026-11-16'), '2026-11-09', '2026-11-16'), false)              // next Monday
  assert.equal(bookingOverlapsRange(bk('2026-11-08'), '2026-11-09', '2026-11-16'), false)
})

test('bookingDayKeys: every occupied day, capped at 31', () => {
  assert.deepEqual(bookingDayKeys(bk('2026-11-10', '2026-11-12')), ['2026-11-10', '2026-11-11', '2026-11-12'])
  assert.equal(bookingDayKeys(bk('2026-01-01', '2027-01-01')).length, 31)
})

test('mondayOf / addDaysStr', () => {
  assert.equal(mondayOf('2026-11-08'), '2026-11-02') // Sunday → previous Monday
  assert.equal(mondayOf('2026-11-09'), '2026-11-09')
  assert.equal(addDaysStr('2026-12-31', 1), '2027-01-01')
})

test('heldMinutesOnDay: multi-day holds call→midnight, all day, midnight→wrap; single day = call→wrap', () => {
  const b = bk('2026-11-10', '2026-11-12')
  assert.deepEqual(heldMinutesOnDay(b, '2026-11-10', 540, 1080), { start: 540, end: 1440 })
  assert.deepEqual(heldMinutesOnDay(b, '2026-11-11', 540, 1080), { start: 0, end: 1440 })
  assert.deepEqual(heldMinutesOnDay(b, '2026-11-12', 540, 1080), { start: 0, end: 1080 })
  assert.equal(heldMinutesOnDay(b, '2026-11-13', 540, 1080), null)
  assert.deepEqual(heldMinutesOnDay(bk('2026-11-10'), '2026-11-10', 540, 1080), { start: 540, end: 1080 })
})
