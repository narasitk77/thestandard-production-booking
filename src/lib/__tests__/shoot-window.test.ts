/**
 * isShootOver — the gate for moving a booking to COMPLETED (auto + manual).
 * Regression guard for the bug where a future booking (07:00–09:00 shoot)
 * showed COMPLETED before it had even started.
 *
 * shootDate / shootEndDate model how Prisma reads @db.Date: a Date at UTC
 * midnight. `now` is a real UTC instant; Bangkok = UTC+7.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isShootOver } from '../shoot-window'

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

test('THE BUG: 07-01 07:00→09:00 shoot, early morning of the shoot day → NOT over', () => {
  // now = 2026-07-01 01:00 Bangkok (2026-06-30 18:00 UTC) — shoot hasn't started
  const now = new Date('2026-06-30T18:00:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 7, 1), shootEndDate: null, estimatedWrap: '09:00' }, now),
    false,
  )
})

test('future shoot day → NOT over', () => {
  // now = 2026-07-01 12:00 Bangkok; shoot is 07-02
  const now = new Date('2026-07-01T05:00:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 7, 2), shootEndDate: null, estimatedWrap: '18:00' }, now),
    false,
  )
})

test('same day, before wrap → NOT over', () => {
  // now = 2026-07-01 08:30 Bangkok (mid-shoot), wrap 09:00
  const now = new Date('2026-07-01T01:30:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 7, 1), shootEndDate: null, estimatedWrap: '09:00' }, now),
    false,
  )
})

test('same day, wrap passed → over', () => {
  // now = 2026-07-01 10:00 Bangkok, wrap 09:00
  const now = new Date('2026-07-01T03:00:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 7, 1), shootEndDate: null, estimatedWrap: '09:00' }, now),
    true,
  )
})

test('shoot day fully passed → over', () => {
  // now = 2026-07-01 12:00 Bangkok; shoot was 06-30
  const now = new Date('2026-07-01T05:00:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 6, 30), shootEndDate: null, estimatedWrap: '09:00' }, now),
    true,
  )
})

test('same day, no wrap → not over before 23:00, over after', () => {
  const before = new Date('2026-07-01T13:00:00Z') // 20:00 Bangkok
  const after = new Date('2026-07-01T16:30:00Z') // 23:30 Bangkok
  assert.equal(isShootOver({ shootDate: day(2026, 7, 1), shootEndDate: null, estimatedWrap: null }, before), false)
  assert.equal(isShootOver({ shootDate: day(2026, 7, 1), shootEndDate: null, estimatedWrap: null }, after), true)
})

test('multi-day: uses shootEndDate, not shootDate', () => {
  // now = 2026-07-01 12:00 Bangkok; shoot runs 06-30 → 07-02 (still going)
  const now = new Date('2026-07-01T05:00:00Z')
  assert.equal(
    isShootOver({ shootDate: day(2026, 6, 30), shootEndDate: day(2026, 7, 2), estimatedWrap: '18:00' }, now),
    false,
  )
})
