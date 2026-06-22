/**
 * v1.84 — isDriveAccessError gates the "impersonate uploader → fall back to
 * service subject" branch. A false negative would 502 an upload that should
 * have fallen back (a user without Shared Drive access), so the real Drive
 * error shapes must all be caught.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDriveAccessError } from '../drive-access'

test('classifies real Drive access errors as fall-back-able', () => {
  // googleapis GaxiosError shapes seen for a non-member of a Shared Drive
  assert.equal(isDriveAccessError({ code: 403, message: 'The user does not have sufficient permissions for file X.' }), true)
  assert.equal(isDriveAccessError({ code: 404, message: 'File not found: ROOT_ID.' }), true)
  assert.equal(isDriveAccessError({ response: { status: 403 }, errors: [{ reason: 'insufficientFilePermissions' }] }), true)
  assert.equal(isDriveAccessError({ status: 404, errors: [{ reason: 'notFound' }] }), true)
  assert.equal(isDriveAccessError({ message: 'Insufficient Permission' }), true)
})

test('does NOT misclassify genuine failures (those must propagate, not fall back)', () => {
  assert.equal(isDriveAccessError({ code: 500, message: 'Internal Error' }), false)
  assert.equal(isDriveAccessError({ code: 429, message: 'Rate Limit Exceeded' }), false)
  assert.equal(isDriveAccessError({ message: 'getaddrinfo ENOTFOUND www.googleapis.com' }), false)
  assert.equal(isDriveAccessError(new Error('Drive resumable init failed: HTTP 400')), false)
  assert.equal(isDriveAccessError(undefined), false)
})
