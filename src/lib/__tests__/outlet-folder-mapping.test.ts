/**
 * v1.149 — guard the hand-maintained OUTLET_FOLDER_BY_CODE map against drift
 * from the OUTLETS master. The map's only remaining job is gating uploads
 * (/api/upload/init hard-400s) and the prep/landing sweeps (silent skip); a
 * 12th outlet added to data.ts without a map line would book + confirm + get
 * real Drive folders from approve, but crew could never upload and the sweeps
 * would silently skip it. This test turns that silent trap into a red CI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OUTLETS } from '../data'
import { hasOutletFolderMapping } from '../outlet-folders'

test('every outlet in the OUTLETS master has a folder mapping (upload/prep gates)', () => {
  for (const o of OUTLETS) {
    assert.equal(
      hasOutletFolderMapping(o.code), true,
      `outlet ${o.code} (${o.name}) is missing from OUTLET_FOLDER_BY_CODE — ` +
      'uploads would 400 and the prep/landing sweeps would skip it silently. ' +
      'Add a line to the map in outlet-folders.ts.',
    )
  }
})
