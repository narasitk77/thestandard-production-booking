/**
 * _SHOOT.txt marker rendering (v1.134 regression).
 *
 * The date lines must render the GREGORIAN year (2026), not the Thai Buddhist
 * year. Plain 'th-TH' defaulted to the Buddhist calendar → "2 ก.ค. 2569" for a
 * normal date, and "2 ก.ค. 3112" when a shootDate was itself stored as
 * Buddhist-2569 (memo 2026-07-09: +543 applied twice). Fixed by rendering with
 * 'th-TH-u-ca-gregory'.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBookingInfo, type BookingInfoInput } from '../booking-info'

function baseInput(overrides: Partial<BookingInfoInput> = {}): BookingInfoInput {
  return {
    bookingCode: 'AGN-260702-02',
    outletName: 'Content Agency',
    outletCode: 'AGN',
    shootDate: new Date(Date.UTC(2026, 6, 2, 3, 0, 0)), // 2 Jul 2026, 10:00 BKK
    episodes: [{ episodeId: 'PP-26-025-S05', title: 'Pre EP.3 - Hat Yai', sequence: 1 }],
    generatedAt: new Date(Date.UTC(2026, 6, 8, 3, 0, 0)),
    ...overrides,
  }
}

test('marker date line shows the Gregorian year (2026), not Buddhist (2569)', () => {
  const txt = renderBookingInfo(baseInput())
  const dateLine = txt.split('\n').find(l => l.includes('วันที่ / Date'))!
  assert.ok(dateLine.includes('2569') === false, `expected no Buddhist year, got: ${dateLine}`)
  assert.ok(dateLine.includes('2026'), `expected Gregorian 2026, got: ${dateLine}`)
})

test('the Production ID line echoes the DB bookingCode verbatim', () => {
  const txt = renderBookingInfo(baseInput())
  assert.ok(txt.includes('Production ID     : AGN-260702-02'))
})

test('a multi-day range renders both dates in Gregorian', () => {
  const txt = renderBookingInfo(baseInput({
    shootEndDate: new Date(Date.UTC(2026, 6, 4, 3, 0, 0)),
  }))
  const dateLine = txt.split('\n').find(l => l.includes('วันที่ / Date'))!
  assert.ok(dateLine.includes('→'), 'expected a date range')
  assert.ok(!dateLine.includes('2569'))
  assert.ok(dateLine.includes('2026'))
})

test('"updated at" footer also renders Gregorian', () => {
  const txt = renderBookingInfo(baseInput())
  const footer = txt.split('\n').find(l => l.includes('อัปเดตล่าสุด'))!
  assert.ok(!footer.includes('2569'))
  assert.ok(footer.includes('2026'))
})
