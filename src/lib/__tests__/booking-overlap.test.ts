import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timeWindowsOverlap } from '../booking-overlap'

test('overlapping windows return true', () => {
  assert.equal(timeWindowsOverlap('09:00', '12:00', '11:00', '14:00'), true)
})

test('adjacent windows (touching edges) do not overlap', () => {
  assert.equal(timeWindowsOverlap('09:00', '12:00', '12:00', '14:00'), false)
})

test('disjoint windows return false', () => {
  assert.equal(timeWindowsOverlap('09:00', '10:00', '13:00', '15:00'), false)
})

test('null end time is treated as open-ended (overlaps a later booking)', () => {
  assert.equal(timeWindowsOverlap('09:00', null, '22:00', '23:00'), true)
})

test('missing other start time means no overlap', () => {
  assert.equal(timeWindowsOverlap('09:00', '12:00', '', null), false)
})

test('fully contained window overlaps', () => {
  assert.equal(timeWindowsOverlap('08:00', '18:00', '10:00', '11:00'), true)
})
