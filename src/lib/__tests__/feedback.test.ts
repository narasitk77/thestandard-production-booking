// v1.166 — ticket state machine + list ordering. These encode the two rules
// that decide whether a reported problem can silently go quiet.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ticketRef, isFeedbackStatus, statusAfterAdminReply, statusAfterReporterReply,
  STATUS_TH, FEEDBACK_STATUSES,
} from '../feedback'

test('ticket refs are stable, padded, quotable', () => {
  assert.equal(ticketRef(1), 'FB-001')
  assert.equal(ticketRef(42), 'FB-042')
  assert.equal(ticketRef(1234), 'FB-1234') // never truncates once past 3 digits
})

test('a reporter replying to a CLOSED ticket reopens it', () => {
  // The failure this prevents: someone says "ยังไม่หายครับ" on a resolved
  // ticket and it stays closed, so nobody ever looks again.
  assert.equal(statusAfterReporterReply('RESOLVED'), 'IN_PROGRESS')
  assert.equal(statusAfterReporterReply('NEW'), 'NEW')
  assert.equal(statusAfterReporterReply('IN_PROGRESS'), 'IN_PROGRESS')
})

test('an admin replying to a NEW ticket has picked it up', () => {
  assert.equal(statusAfterAdminReply('NEW'), 'IN_PROGRESS')
  assert.equal(statusAfterAdminReply('IN_PROGRESS'), 'IN_PROGRESS')
  assert.equal(statusAfterAdminReply('RESOLVED'), 'RESOLVED')
})

test('junk status from an old row never crashes the transition', () => {
  assert.equal(statusAfterReporterReply('WEIRD'), 'NEW')
  assert.equal(statusAfterAdminReply('WEIRD'), 'IN_PROGRESS')
})

test('only the three known statuses validate', () => {
  for (const s of FEEDBACK_STATUSES) assert.equal(isFeedbackStatus(s), true)
  for (const bad of ['new', 'OPEN', '', null, 7]) assert.equal(isFeedbackStatus(bad as any), false)
  for (const s of FEEDBACK_STATUSES) assert.ok(STATUS_TH[s], `${s} needs Thai copy`)
})

test('the admin list must show untouched tickets FIRST — alphabetical would not', () => {
  const STATUS_ORDER: Record<string, number> = { NEW: 0, IN_PROGRESS: 1, RESOLVED: 2 }
  const rows = [
    { status: 'RESOLVED', at: 30 }, { status: 'IN_PROGRESS', at: 20 },
    { status: 'NEW', at: 10 }, { status: 'NEW', at: 25 },
  ]
  const sorted = [...rows].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.at - a.at)
  assert.deepEqual(sorted.map(r => `${r.status}:${r.at}`),
    ['NEW:25', 'NEW:10', 'IN_PROGRESS:20', 'RESOLVED:30'])
  // and prove the naive DB sort would have been wrong
  assert.deepEqual([...FEEDBACK_STATUSES].sort(), ['IN_PROGRESS', 'NEW', 'RESOLVED'])
})
