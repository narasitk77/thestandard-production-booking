// maint 2026-11-08 (B2a) — "กล้องเต็ม/คนเต็ม" counts the PEAK in use at once,
// not the sum of every booking that touches the candidate's window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summariseLoad, type LoadDemand, type Pools } from '../resource-load'

const POOLS: Pools = { cameras: 9, videographers: 5, switchers: 2 }
const slot = (o: Partial<LoadDemand>): LoadDemand => ({
  callTime: '09:00', estimatedWrap: '18:00', shootType: 'STUDIO', cameraCount: 0, ...o,
})
const cams = (s: ReturnType<typeof summariseLoad>) => s.lines.find(l => l.key === 'cameras')!

test('THE BUG: two others that never overlap EACH OTHER are not added together', () => {
  const s = summariseLoad(slot({ cameraCount: 3 }), [
    slot({ callTime: '09:00', estimatedWrap: '11:00', cameraCount: 4 }),
    slot({ callTime: '14:00', estimatedWrap: '16:00', cameraCount: 4 }),
  ], POOLS)
  assert.equal(cams(s).others, 4, 'at most 4 out at any moment')
  assert.equal(cams(s).total, 7)
  assert.equal(cams(s).over, false, 'was "กล้องเต็ม ขาด 2" (3+4+4 = 11)')
  assert.equal(s.competing, 2, 'both still compete with the candidate')
})

test('truly concurrent others still add up', () => {
  const s = summariseLoad(slot({ cameraCount: 3 }), [
    slot({ callTime: '09:00', estimatedWrap: '12:00', cameraCount: 4 }),
    slot({ callTime: '10:00', estimatedWrap: '15:00', cameraCount: 4 }),
  ], POOLS)
  assert.equal(cams(s).others, 8)
  assert.equal(cams(s).over, true)
  assert.equal(cams(s).shortBy, 2)
})

test('back-to-back others (12:00 end, 12:00 start) do not stack', () => {
  const s = summariseLoad(slot({ cameraCount: 1 }), [
    slot({ callTime: '09:00', estimatedWrap: '12:00', cameraCount: 5 }),
    slot({ callTime: '12:00', estimatedWrap: '15:00', cameraCount: 5 }),
  ], POOLS)
  assert.equal(cams(s).others, 5)
})

test('only the part inside the candidate window counts', () => {
  // candidate 13:00–15:00; the two others overlap each other 14:00–14:30 only
  const s = summariseLoad(slot({ callTime: '13:00', estimatedWrap: '15:00', cameraCount: 2 }), [
    slot({ callTime: '08:00', estimatedWrap: '14:30', cameraCount: 4 }),
    slot({ callTime: '14:00', estimatedWrap: '17:00', cameraCount: 4 }),
  ], POOLS)
  assert.equal(cams(s).others, 8, '14:00–14:30 both are out')
  // …and a job that wraps exactly when the candidate starts is not in it at all
  const t = summariseLoad(slot({ callTime: '13:00', estimatedWrap: '15:00', cameraCount: 2 }), [
    slot({ callTime: '08:00', estimatedWrap: '13:00', cameraCount: 4 }),
    slot({ callTime: '14:00', estimatedWrap: '17:00', cameraCount: 4 }),
  ], POOLS)
  assert.equal(cams(t).others, 4)
})

test('multi-day candidate with dates: jobs on different days are not summed', () => {
  const trip = slot({ cameraCount: 2, multiDay: true, shootDate: '2026-11-20', shootEndDate: '2026-11-22' })
  const s = summariseLoad(trip, [
    slot({ cameraCount: 4, shootDate: '2026-11-20' }),
    slot({ cameraCount: 4, shootDate: '2026-11-21' }),
    slot({ cameraCount: 3, shootDate: '2026-11-22' }),
  ], POOLS)
  assert.equal(cams(s).others, 4, 'worst single day, not 4+4+3')
  assert.equal(cams(s).over, false)

  const sameDay = summariseLoad(trip, [
    slot({ cameraCount: 4, shootDate: '2026-11-21' }),
    slot({ cameraCount: 4, shootDate: '2026-11-21' }),
  ], POOLS)
  assert.equal(cams(sameDay).others, 8)
  assert.equal(cams(sameDay).over, true)
})
