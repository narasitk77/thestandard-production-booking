import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, timeEditedSince, actionInfo, type HistoryRow } from '../history-format'

const row = (action: string, changes: unknown): HistoryRow =>
  ({ id: action, at: '2026-10-01T00:00:00Z', action, actorEmail: null, fromStatus: null, toStatus: null, changes })

test('diffLines keeps full values and skips message fields', () => {
  const long = 'x'.repeat(500)
  const l = diffLines({ callTime: { from: '12:00', to: '13:00' }, notes: { from: null, to: long }, message: 'hi' })
  assert.equal(l.length, 2)
  assert.equal(l[0].label, 'เวลาเรียก (Call)')
  assert.equal(l[1].to.length, 500)
  assert.equal(l[1].from, '—')
})

test('diffLines accepts bare values', () => {
  assert.deepEqual(diffLines({ callTime: '09:00' }).map(x => [x.from, x.to]), [[undefined, '09:00']])
})

test('timeEditedSince only looks at newer rows and only time fields', () => {
  const rows = [row('booking.update', { notes: { from: 'a', to: 'b' } }), row('booking.time_change_request', {})]
  assert.equal(timeEditedSince(rows, 1), false)
  rows.unshift(row('booking.update', { callTime: { from: '12:00', to: '13:00' } }))
  assert.equal(timeEditedSince(rows, 2), true)
})

test('unknown action shows raw string', () => {
  assert.equal(actionInfo('foo.bar').label, 'foo.bar')
})
