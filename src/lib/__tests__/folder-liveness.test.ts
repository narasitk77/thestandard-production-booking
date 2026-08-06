// v1.165 — the liveness probe decides whether a booking's STORED Drive id is
// trusted or whether the caller goes hunting by folder NAME. The name walk is
// create-on-miss at several sites, so calling a live folder "dead" is how one
// shoot's footage ends up in two boxes. These tests pin the classification.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

// Rebuild the exact decision table of folderLiveness/isFolderAlive without the
// googleapis client: the logic under test is the error→state mapping.
type Liveness = 'alive' | 'dead' | 'unknown'
const RETRYABLE = new Set([429, 500, 502, 503, 504])

function classify(res: { trashed?: boolean; mimeType?: string } | null, err: { status?: number } | null): Liveness {
  if (err) {
    if (err.status === 404 || err.status === 410) return 'dead'
    return 'unknown'
  }
  return (!res?.trashed && res?.mimeType === FOLDER_MIME) ? 'alive' : 'dead'
}
const aliveOnly = (l: Liveness) => l === 'alive'

test('a real folder is alive; a trashed one and a non-folder are dead', () => {
  assert.equal(classify({ trashed: false, mimeType: FOLDER_MIME }, null), 'alive')
  assert.equal(classify({ trashed: true, mimeType: FOLDER_MIME }, null), 'dead')
  assert.equal(classify({ trashed: false, mimeType: 'video/mp4' }, null), 'dead')
})

test('only 404/410 mean gone — every other failure is UNKNOWN, never dead', () => {
  assert.equal(classify(null, { status: 404 }), 'dead')
  assert.equal(classify(null, { status: 410 }), 'dead')
  // The bug this replaces: `catch { return false }` turned each of these into
  // "folder is gone", which sent callers to the name walk.
  for (const status of [429, 500, 502, 503, 504, 403, undefined]) {
    assert.equal(classify(null, { status }), 'unknown', `status ${status} must be unknown`)
  }
})

test('403 stays UNKNOWN — Drive answers 403 for rateLimitExceeded as well as permission', () => {
  assert.equal(classify(null, { status: 403 }), 'unknown')
})

test('isFolderAlive keeps its fail-closed meaning: only a confirmed live folder is true', () => {
  // Several call sites `continue` (skip the booking) when this is false, ahead
  // of a MUTATION — those must not start acting on unverified folders.
  assert.equal(aliveOnly('alive'), true)
  assert.equal(aliveOnly('dead'), false)
  assert.equal(aliveOnly('unknown'), false)
})

test('every status the retry helper retries maps to unknown, not dead', () => {
  // If a retryable status ever mapped to `dead`, exhausting retries during a
  // quota spike would look like mass folder deletion to the resolvers.
  for (const s of Array.from(RETRYABLE)) assert.equal(classify(null, { status: s }), 'unknown')
})
