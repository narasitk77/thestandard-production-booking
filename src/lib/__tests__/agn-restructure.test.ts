/**
 * AGN restructure — pure helpers (v1.149).
 * The Drive I/O is integration-tested via the dry-run endpoint; here we lock
 * down the legacy-marker detection that decides move-and-RENAME (vs plain move)
 * so a moved "_SHOOT-<code>.txt" can never survive under its legacy name and
 * double-log the shoot in the footage crawler.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLegacyMarkerName } from '../agn-restructure'
import { CANONICAL_MARKER_NAME } from '../shoot-marker'

test('isLegacyMarkerName matches box-level "_SHOOT-<code>.txt" markers', () => {
  assert.equal(isLegacyMarkerName('_SHOOT-AGN-260708-LOC-01.txt'), true)
  assert.equal(isLegacyMarkerName('_SHOOT-AGN-260708-01.txt'), true)
  assert.equal(isLegacyMarkerName('_shoot-agn-260708-loc-01.TXT'), true) // case-insensitive
})

test('isLegacyMarkerName does NOT match the canonical marker or non-markers', () => {
  assert.equal(isLegacyMarkerName(CANONICAL_MARKER_NAME), false) // "_SHOOT.txt"
  assert.equal(isLegacyMarkerName('_SHOOT.txt'), false)
  assert.equal(isLegacyMarkerName('EP01 · title'), false)
  assert.equal(isLegacyMarkerName('_SHOOT-.txt'), false) // empty id — not a code
  assert.equal(isLegacyMarkerName('notes.txt'), false)
})
