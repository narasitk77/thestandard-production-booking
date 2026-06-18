import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bkkAt, durationHours } from '../planning'

test('durationHours — same-day span', () => {
  assert.equal(durationHours(bkkAt('2026-01-05', '09:00'), bkkAt('2026-01-05', '11:30')), '2.5')
})

test('durationHours — overnight wrap on one calendar day adds 24h', () => {
  // 22:00 → 02:00 same day = 4h (not -20h)
  assert.equal(durationHours(bkkAt('2026-01-05', '22:00'), bkkAt('2026-01-05', '02:00')), '4')
})

test('durationHours — multi-day via end date', () => {
  assert.equal(durationHours(bkkAt('2026-01-05', '17:00'), bkkAt('2026-01-07', '03:00')), '34')
})

test('durationHours — missing time returns empty', () => {
  assert.equal(durationHours(bkkAt('2026-01-05', null), bkkAt('2026-01-05', '11:00')), '')
  assert.equal(durationHours(null, null), '')
})

test('bkkAt — invalid inputs are null', () => {
  assert.equal(bkkAt(null, '09:00'), null)
  assert.equal(bkkAt('2026-01-05', ''), null)
})
