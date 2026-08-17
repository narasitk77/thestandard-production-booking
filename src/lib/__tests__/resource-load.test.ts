// v1.177 — the load advisory. These tests are written from the rules the team
// stated in their own words, so each one names the scenario it protects.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isOffSite, occupancyOf, slotsCompete, summariseLoad, loadWarningsTh,
  TRAVEL_BUFFER_MIN, type LoadDemand, type Pools,
} from '../resource-load'

const POOLS: Pools = { cameras: 9, videographers: 5, switchers: 2 }
const studio = (o: Partial<LoadDemand> = {}): LoadDemand => ({
  callTime: '09:00', estimatedWrap: '12:00', shootType: 'STUDIO',
  cameraCount: 3, videographerCount: 1, switcherCount: 0, ...o,
})

test('a studio shoot frees its gear at wrap — back-to-back is fine', () => {
  const a = studio({ callTime: '09:00', estimatedWrap: '12:00' })
  const b = studio({ callTime: '12:00', estimatedWrap: '15:00' })
  assert.equal(slotsCompete(a, b), false)
})

test('an off-site shoot does NOT free its gear at wrap — 12:00 → 12:00 is ไม่ทัน', () => {
  // The stated rule: first job goes out and ends 12:00, second starts 12:00 —
  // "นับเป็นไม่ทัน", because the kit is still in the van.
  const out = studio({ callTime: '09:00', estimatedWrap: '12:00', shootType: 'ON_LOCATION' })
  const next = studio({ callTime: '12:00', estimatedWrap: '15:00' })
  assert.equal(slotsCompete(out, next), true)
  assert.equal(occupancyOf(out).end, '13:00', 'wrap 12:00 + 60min travel')
  assert.equal(occupancyOf(out).travelPadded, true)
})

test('the travel buffer is finite — a later start clears the returning kit', () => {
  const out = studio({ callTime: '09:00', estimatedWrap: '12:00', shootType: 'ON_LOCATION' })
  const later = studio({ callTime: '13:00', estimatedWrap: '16:00' })
  assert.equal(slotsCompete(out, later), false, `${TRAVEL_BUFFER_MIN}min after 12:00 is 13:00`)
})

test('EVENT travels, REMOTE_ONLINE does not', () => {
  assert.equal(isOffSite('EVENT'), true)
  assert.equal(isOffSite('ON_LOCATION'), true)
  assert.equal(isOffSite('STUDIO'), false)
  assert.equal(isOffSite('REMOTE_ONLINE'), false)
  assert.equal(isOffSite(null), false)
})

test('three overlapping 3-camera shoots fill the pool; a fourth must rent', () => {
  // The stated example: 09:00–12:00 with three 3-camera jobs = 9 cameras. One
  // more job in that window needs rentals, and only until 12:00.
  const others = [studio(), studio(), studio()]
  const fourth = studio({ cameraCount: 2 })
  const s = summariseLoad(fourth, others, POOLS)
  const cams = s.lines.find(l => l.key === 'cameras')!
  assert.equal(cams.others, 9)
  assert.equal(cams.total, 11)
  assert.equal(cams.over, true)
  assert.equal(cams.shortBy, 2)
  assert.equal(s.competing, 3)

  // …and the same job in the afternoon is clear, because the morning released.
  const afternoon = summariseLoad(studio({ callTime: '13:00', estimatedWrap: '16:00', cameraCount: 2 }), others, POOLS)
  assert.equal(afternoon.lines.find(l => l.key === 'cameras')!.over, false)
  assert.equal(afternoon.competing, 0)
})

test('a multi-day booking holds its cameras around the clock, not just 09:00–18:00', () => {
  // The kit does not come back each evening on a multi-day job, so an 20:00 shoot
  // on day 2 cannot have those cameras either. Date-range matching is the DB
  // layer's job; what this module owes is whole-day occupancy once told multiDay.
  const trip = studio({ cameraCount: 2, callTime: '08:00', estimatedWrap: '18:00', multiDay: true })
  assert.equal(occupancyOf(trip).start, '00:00')
  assert.equal(occupancyOf(trip).end, '23:59')
  for (const call of ['06:00', '10:00', '20:00']) {
    assert.equal(slotsCompete(trip, studio({ callTime: call, estimatedWrap: '23:00' })), true, `still held at ${call}`)
  }
  // The same row WITHOUT the multiDay flag releases in the evening.
  const oneDay = { ...trip, multiDay: false }
  assert.equal(slotsCompete(oneDay, studio({ callTime: '20:00', estimatedWrap: '23:00' })), false)
})

test('crew shortage is reported separately from cameras — different remedy', () => {
  const others = [studio({ videographerCount: 3, cameraCount: 1 }), studio({ videographerCount: 2, cameraCount: 1 })]
  const s = summariseLoad(studio({ videographerCount: 2, cameraCount: 1 }), others, POOLS)
  const vids = s.lines.find(l => l.key === 'videographers')!
  assert.equal(vids.total, 7)
  assert.equal(vids.over, true)
  assert.equal(s.lines.find(l => l.key === 'cameras')!.over, false, 'cameras still fit')

  const th = loadWarningsTh(s)
  assert.ok(th.some(t => t.includes('คนเต็มต้องจ้างฟรีแลนซ์')), 'people → freelancer')
  assert.ok(!th.some(t => t.includes('กล้องเต็ม')), 'no camera warning when cameras fit')
})

test('the camera warning says rental, and every warning ends with who fixes it', () => {
  const s = summariseLoad(studio({ cameraCount: 4 }), [studio({ cameraCount: 3 }), studio({ cameraCount: 3 })], POOLS)
  const th = loadWarningsTh(s)
  assert.ok(th[0].includes('กล้องเต็ม อาจมีการเช่าอุปกรณ์'))
  assert.ok(th[0].includes('10/9'))
  assert.match(th[th.length - 1], /admin จะจัดหา/, 'closes with admin sourcing it')
})

test('nothing over capacity means no text at all', () => {
  assert.deepEqual(loadWarningsTh(summariseLoad(studio(), [studio()], POOLS)), [])
})

test('the travel note only appears alongside a real shortage', () => {
  const out = studio({ callTime: '09:00', estimatedWrap: '12:00', shootType: 'ON_LOCATION', cameraCount: 8 })
  const tight = summariseLoad(studio({ callTime: '12:00', estimatedWrap: '15:00', cameraCount: 3 }), [out], POOLS)
  assert.ok(tight.travelTight, 'the 12:00 → 12:00 case is flagged')
  const th = loadWarningsTh(tight)
  assert.ok(th.some(t => t.includes('เดินทางกลับไม่ทัน')), 'explains why a free-looking slot is full')

  // Same adjacency, but the pool is not exceeded → stay quiet.
  const light = summariseLoad(studio({ callTime: '12:00', estimatedWrap: '15:00', cameraCount: 1 }), [studio({ ...out, cameraCount: 1 })], POOLS)
  assert.deepEqual(loadWarningsTh(light), [])
})

test('a resource this booking never asked for is not its warning', () => {
  // Caught on the first live call: a shoot requesting 0 switchers was told
  // "สวิตเชอร์ 2/1 คน (ของคุณ 0)". True, and none of that producer's business.
  const others = [studio({ switcherCount: 1, cameraCount: 1 }), studio({ switcherCount: 1, cameraCount: 1 })]
  const s = summariseLoad(studio({ switcherCount: 0, cameraCount: 1 }), others, POOLS)
  assert.equal(s.lines.find(l => l.key === 'switchers')!.over, false)
  assert.deepEqual(loadWarningsTh(s), [])
  // Ask for one, and the same slot does warn.
  const asking = summariseLoad(studio({ switcherCount: 1, cameraCount: 1 }), others, POOLS)
  assert.equal(asking.lines.find(l => l.key === 'switchers')!.over, true)
})

test('an unknown pool size never warns — a missing roster is not a shortage', () => {
  const s = summariseLoad(studio({ cameraCount: 99 }), [studio({ cameraCount: 99 })], { cameras: 0, videographers: 0, switchers: 0 })
  assert.equal(s.lines.every(l => !l.over), true)
  assert.deepEqual(loadWarningsTh(s), [])
})

test('a missing wrap time occupies call + 8h, not the whole day', () => {
  const noWrap = studio({ callTime: '09:00', estimatedWrap: null })
  assert.equal(occupancyOf(noWrap).wrap, '17:00')
  assert.equal(occupancyOf(noWrap).estimated, true)
  assert.equal(slotsCompete(noWrap, studio({ callTime: '18:00', estimatedWrap: '20:00' })), false)
})

test('blank and negative counts read as zero rather than NaN', () => {
  const s = summariseLoad(studio({ cameraCount: null, videographerCount: -2 }), [studio({ cameraCount: undefined })], POOLS)
  const cams = s.lines.find(l => l.key === 'cameras')!
  assert.equal(cams.own, 0)
  assert.equal(cams.others, 0)
  assert.equal(s.lines.find(l => l.key === 'videographers')!.own, 0)
})
