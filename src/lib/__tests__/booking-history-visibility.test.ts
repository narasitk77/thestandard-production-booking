// v1.166.1 — the filter that stands between "we logged something against a
// booking" and "every signed-in colleague can read it".
//
// The bug this exists to prevent shipped and was caught in review: a peer-review
// submission logged `entityType: 'Booking'` with the rater's team in `changes`,
// and this endpoint hands those rows — payload included — to ANY signed-in
// user. The rated producer could name their rater in one GET.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPubliclyVisibleAction, visibleHistory, PUBLIC_HISTORY_PREFIXES } from '../booking-history-visibility'

test('the booking lifecycle stays visible — this endpoint must keep working', () => {
  for (const a of [
    'booking.create', 'booking.update', 'booking.status_change', 'booking.delivered',
    'booking.cancel_requested', 'booking.producer_edit', 'booking.episodes_added',
    'booking.notified_ready', 'booking.move_outlet', 'approve',
    'document.attach', 'document.upload',
  ]) {
    assert.equal(isPubliclyVisibleAction(a), true, a)
  }
})

test('THE REGRESSION: a review action is never publicly visible', () => {
  for (const a of ['review.submitted', 'review.invites_sent', 'review.exported']) {
    assert.equal(isPubliclyVisibleAction(a), false, a)
  }
})

test('FAIL-CLOSED: an action nobody listed is hidden, not exposed', () => {
  // This is the whole design. A future feature that logs against a booking is
  // invisible to non-staff until someone deliberately adds its prefix — the
  // opposite of the default that caused the leak.
  for (const a of [
    'some.future.feature', 'salary.updated', 'hr.complaint_filed',
    'feedback.reply', 'ot.approved', '', '   ',
  ]) {
    assert.equal(isPubliclyVisibleAction(a), false, JSON.stringify(a))
  }
})

test('a prefix must not match a longer unrelated word', () => {
  // 'approve' is an exact-match entry, not a prefix — otherwise a future
  // 'approve.salary' style action would ride in on it.
  assert.equal(isPubliclyVisibleAction('approve'), true)
  assert.equal(isPubliclyVisibleAction('approve.salary'), false)
  assert.equal(isPubliclyVisibleAction('approvals.secret'), false)
})

test('console viewers keep the unfiltered trail; everyone else gets the subset', () => {
  const rows = [
    { action: 'booking.create' },
    { action: 'review.submitted' },
    { action: 'drive.folder_renamed' },
    { action: 'approve' },
  ]
  assert.deepEqual(visibleHistory(rows, true).map(r => r.action),
    ['booking.create', 'review.submitted', 'drive.folder_renamed', 'approve'])
  assert.deepEqual(visibleHistory(rows, false).map(r => r.action),
    ['booking.create', 'approve'])
})

test('the allow-list is small and intentional — growing it needs a reason', () => {
  // A guard on scope creep: if this number climbs, someone widened who can read
  // audit payloads on a booking. That should be a deliberate, reviewed change.
  assert.ok(PUBLIC_HISTORY_PREFIXES.length <= 4,
    `allow-list grew to ${PUBLIC_HISTORY_PREFIXES.length} — justify each entry`)
})
