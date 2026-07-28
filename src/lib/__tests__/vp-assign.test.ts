// v1.156.1 — the VP auto-seed must be invisible to "did an admin assign crew?"
// surfaces (workspace unassigned filter/count, approve requireAttendees), while
// a MANUAL assignment of the same person on a normal booking still counts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminAssignedEmails, VP_ASSIGNEE_DEFAULT } from '../vp-assign'

test('VP booking with only the auto-seed counts as admin-unassigned', () => {
  assert.deepEqual(adminAssignedEmails([VP_ASSIGNEE_DEFAULT], true), [])
})

test('VP booking with real crew on top of the seed keeps the crew', () => {
  const crew = ['somchai.k@thestandard.co', VP_ASSIGNEE_DEFAULT]
  assert.deepEqual(adminAssignedEmails(crew, true), ['somchai.k@thestandard.co'])
})

test('the VP dev manually assigned to a NON-VP booking still counts as crew', () => {
  assert.deepEqual(adminAssignedEmails([VP_ASSIGNEE_DEFAULT], false), [VP_ASSIGNEE_DEFAULT])
})

test('seed matching is case/whitespace-insensitive', () => {
  assert.deepEqual(adminAssignedEmails([` ${VP_ASSIGNEE_DEFAULT.toUpperCase()} `], true), [])
})

test('null/undefined/empty inputs are safe', () => {
  assert.deepEqual(adminAssignedEmails(null, true), [])
  assert.deepEqual(adminAssignedEmails(undefined, false), [])
  assert.deepEqual(adminAssignedEmails(['', '  '], true), [])
})
