import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveWrap, timeWindowsOverlap, addMinutesClamped } from '../shoot-window'

// v1.118 — the camera-overlap accuracy fix: a missing wrap must NOT be treated
// as 23:59 (which made a shoot "hold" the whole day and clash with everything).

test('effectiveWrap: uses the entered wrap when present', () => {
  assert.deepEqual(effectiveWrap('09:00', '12:00'), { end: '12:00', estimated: false })
  assert.deepEqual(effectiveWrap('09:00', '  18:30 '), { end: '18:30', estimated: false })
})

test('effectiveWrap: estimates call + 8h (clamped) when blank', () => {
  assert.deepEqual(effectiveWrap('09:00', null), { end: '17:00', estimated: true })
  assert.deepEqual(effectiveWrap('09:00', ''), { end: '17:00', estimated: true })
  assert.deepEqual(effectiveWrap('20:00', null), { end: '23:59', estimated: true }) // clamped, not next-day
})

test('addMinutesClamped: same-day clamp at 23:59', () => {
  assert.equal(addMinutesClamped('09:00', 90), '10:30')
  assert.equal(addMinutesClamped('23:30', 120), '23:59')
})

test('timeWindowsOverlap: real overlaps vs touching edges vs disjoint', () => {
  assert.equal(timeWindowsOverlap('09:00', '12:00', '11:00', '14:00'), true)   // overlap
  assert.equal(timeWindowsOverlap('09:00', '12:00', '12:00', '15:00'), false)  // touch at 12:00 = no clash
  assert.equal(timeWindowsOverlap('09:00', '12:00', '13:00', '17:00'), false)  // disjoint
  assert.equal(timeWindowsOverlap('', '12:00', '13:00', '17:00'), false)       // no start → unplaceable
})

test('scenario: two same-day shoots, no wrap entered, DIFFERENT times → no clash', () => {
  // morning shoot 09:00 (→ est 17:00) and evening shoot 18:00 (→ est 23:59)
  const a = effectiveWrap('09:00', null)   // 17:00
  const b = effectiveWrap('18:00', null)   // 23:59
  assert.equal(timeWindowsOverlap('09:00', a.end, '18:00', b.end), false) // used to be a false clash
})

test('scenario: two same-day shoots that DO overlap in time → clash', () => {
  const a = effectiveWrap('09:00', '13:00')
  const b = effectiveWrap('12:00', '16:00')
  assert.equal(timeWindowsOverlap('09:00', a.end, '12:00', b.end), true)
})
