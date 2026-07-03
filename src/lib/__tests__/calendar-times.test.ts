import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeEventTimes } from '../google-calendar'

// v1.112 — the multi-day / overnight calendar bug: an end computed on the START
// date gives end ≤ start → Google rejects "The specified time range is empty".

test('same-day daytime shoot: end on the same date', () => {
  const { startTime, endTime } = computeEventTimes({ shootDate: '2026-07-02', callTime: '09:00', estimatedWrap: '18:00' })
  assert.equal(startTime, '2026-07-02T09:00:00+07:00')
  assert.equal(endTime, '2026-07-02T18:00:00+07:00')
  assert.ok(new Date(endTime) > new Date(startTime))
})

test('overnight single-day shoot (wrap ≤ call, no end date): end rolls to next day', () => {
  // The reported TSS-TSL case shape: 22:00 → 09:00 with no explicit end date.
  const { startTime, endTime } = computeEventTimes({ shootDate: '2026-07-09', callTime: '22:00', estimatedWrap: '09:00' })
  assert.equal(startTime, '2026-07-09T22:00:00+07:00')
  assert.equal(endTime, '2026-07-10T09:00:00+07:00')
  assert.ok(new Date(endTime) > new Date(startTime), 'end must be after start (non-empty range)')
})

test('multi-day shoot with explicit shootEndDate: end uses the wrap date', () => {
  // Thu 09 → Sun 12 Jul, 22:00 → 09:00 (On Location @ Mumbai).
  const { startTime, endTime } = computeEventTimes({
    shootDate: '2026-07-09', shootEndDate: '2026-07-12', callTime: '22:00', estimatedWrap: '09:00',
  })
  assert.equal(startTime, '2026-07-09T22:00:00+07:00')
  assert.equal(endTime, '2026-07-12T09:00:00+07:00')
  assert.ok(new Date(endTime) > new Date(startTime))
})

test('multi-day shoot where wrap > call: still uses the end date, no extra roll', () => {
  const { endTime } = computeEventTimes({
    shootDate: '2026-07-09', shootEndDate: '2026-07-11', callTime: '08:00', estimatedWrap: '17:00',
  })
  assert.equal(endTime, '2026-07-11T17:00:00+07:00')
})

test('no estimatedWrap: default +4h (unchanged behavior)', () => {
  const { startTime, endTime } = computeEventTimes({ shootDate: '2026-07-02', callTime: '10:00', estimatedWrap: null })
  assert.equal(startTime, '2026-07-02T10:00:00+07:00')
  assert.equal(endTime, '2026-07-02T14:00:00+07:00')
})

test('Date objects (not strings) for shootDate/shootEndDate work', () => {
  const { startTime, endTime } = computeEventTimes({
    shootDate: new Date('2026-07-09T00:00:00Z'), shootEndDate: new Date('2026-07-12T00:00:00Z'),
    callTime: '22:00', estimatedWrap: '09:00',
  })
  assert.equal(startTime, '2026-07-09T22:00:00+07:00')
  assert.equal(endTime, '2026-07-12T09:00:00+07:00')
})
