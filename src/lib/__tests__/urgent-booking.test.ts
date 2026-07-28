// v1.156 — urgent-booking lead-day math. shootDate is @db.Date (midnight UTC)
// while createdAt is a wall-clock timestamp; these tests pin the Bangkok-tz
// day-index comparison that avoids the off-by-one across that mismatch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { urgentLeadDays, isUrgentLead, urgentLeadThreshold } from '../urgent-booking'

// A shootDate as Prisma stores it: DATE column = midnight UTC of that day.
const dbDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

test('booked in the evening BKK for a shoot the next calendar day = lead 1', () => {
  // 2026-07-28 23:30 BKK = 16:30 UTC; shoot 2026-07-29
  const bookedAt = new Date('2026-07-28T16:30:00.000Z')
  assert.equal(urgentLeadDays(dbDate('2026-07-29'), bookedAt), 1)
})

test('same-day booking = lead 0 — even near midnight where naive ms-diff breaks', () => {
  // 00:30 BKK on the 29th is still 17:30 UTC on the 28th — a raw ms diff against
  // midnight-UTC shootDate would say the shoot is in the past. Day-index math says 0.
  const bookedAt = new Date('2026-07-28T17:30:00.000Z') // = 2026-07-29 00:30 BKK
  assert.equal(urgentLeadDays(dbDate('2026-07-29'), bookedAt), 0)
})

test('a back-filled booking for a past shoot has negative lead and is NOT urgent', () => {
  const bookedAt = new Date('2026-07-28T03:00:00.000Z')
  assert.equal(urgentLeadDays(dbDate('2026-07-25'), bookedAt), -3)
  assert.equal(isUrgentLead(dbDate('2026-07-25'), bookedAt, 2), false)
})

test('threshold boundary: lead 2 is urgent at maxLead 2, lead 3 is not', () => {
  const bookedAt = new Date('2026-07-28T03:00:00.000Z') // 10:00 BKK
  assert.equal(isUrgentLead(dbDate('2026-07-30'), bookedAt, 2), true)  // +2
  assert.equal(isUrgentLead(dbDate('2026-07-31'), bookedAt, 2), false) // +3
})

test('urgentLeadThreshold: default 2, env override, junk falls back', () => {
  const orig = process.env.URGENT_LEAD_DAYS
  try {
    delete process.env.URGENT_LEAD_DAYS
    assert.equal(urgentLeadThreshold(), 2)
    process.env.URGENT_LEAD_DAYS = '1'
    assert.equal(urgentLeadThreshold(), 1)
    process.env.URGENT_LEAD_DAYS = '0' // "same-day only" is a valid setting
    assert.equal(urgentLeadThreshold(), 0)
    process.env.URGENT_LEAD_DAYS = 'junk'
    assert.equal(urgentLeadThreshold(), 2)
    process.env.URGENT_LEAD_DAYS = '-5' // negative = nonsense → default
    assert.equal(urgentLeadThreshold(), 2)
  } finally {
    if (orig === undefined) delete process.env.URGENT_LEAD_DAYS
    else process.env.URGENT_LEAD_DAYS = orig
  }
})
