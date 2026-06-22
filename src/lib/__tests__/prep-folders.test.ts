/**
 * v1.86 — bangkokTodayRange resolves "today" in Bangkok (UTC+7) even though the
 * container runs UTC. A wrong range would prep yesterday's/tomorrow's shoots.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bangkokTodayRange } from '../prep-folders'

test('bangkokTodayRange = midnight-UTC bounds of the Bangkok calendar day', () => {
  // 2026-06-22 03:00Z = 2026-06-22 10:00 Bangkok → today = Bangkok Jun 22.
  // shootDate is @db.Date (stored midnight-UTC), so bounds are date midnights.
  const { start, end } = bangkokTodayRange(new Date('2026-06-22T03:00:00Z'))
  assert.equal(start.toISOString(), '2026-06-22T00:00:00.000Z')
  assert.equal(end.toISOString(), '2026-06-23T00:00:00.000Z')

  const inRange = (iso: string) => { const d = new Date(iso).getTime(); return d >= start.getTime() && d < end.getTime() }
  assert.equal(inRange('2026-06-22T00:00:00Z'), true)   // a Jun 22 shoot (@db.Date)
  assert.equal(inRange('2026-06-21T00:00:00Z'), false)  // yesterday
  assert.equal(inRange('2026-06-23T00:00:00Z'), false)  // tomorrow
})

test('Bangkok day rolls over at 17:00Z (= Bangkok midnight)', () => {
  // 2026-06-22 16:00Z = 2026-06-22 23:00 Bangkok → still Bangkok Jun 22.
  assert.equal(bangkokTodayRange(new Date('2026-06-22T16:00:00Z')).start.toISOString(), '2026-06-22T00:00:00.000Z')
  // 2026-06-22 17:30Z = 2026-06-23 00:30 Bangkok → Bangkok Jun 23.
  assert.equal(bangkokTodayRange(new Date('2026-06-22T17:30:00Z')).start.toISOString(), '2026-06-23T00:00:00.000Z')
})
