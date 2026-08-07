// v1.167 — every rule here was written after something went wrong in production.
// These tests are the record of WHICH thing, so a future refactor cannot quietly
// undo one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isShootMarkerFile, markerCodeFromFilename, markerDateHasBuddhistYear,
  isRealContentFile, hasRealFiles, landingMayBeTrashed, lastShootDay, spanCoversDay,
  probeSaysSafeToCreate, probeBlocksDestructiveAction,
  isAppShapedFolderName, isAppShapedEpName,
  isDuplicateFile, immutableLead, twinsMatch,
} from '../reconciler/guards'

// ── markers ─────────────────────────────────────────────────────────────────

test('marker detection standardises on the \\b form — the loose copies were wrong', () => {
  assert.equal(isShootMarkerFile('_SHOOT.txt'), true)
  assert.equal(isShootMarkerFile('_SHOOT-NWS-260817-01.txt'), true)
  // THE DIVERGENCE: four call sites used /^_SHOOT.*\.txt$/i and would call these
  // markers. If a crew member names a file _SHOOTLIST.txt, the loose form makes
  // the landing folder look EMPTY and the cleanup trashes their work.
  assert.equal(isShootMarkerFile('_SHOOTLIST.txt'), false)
  assert.equal(isShootMarkerFile('_SHOOTING-notes.txt'), false)
  assert.equal(isShootMarkerFile('shoot.txt'), false)
  assert.equal(isShootMarkerFile('clip.mp4'), false)
})

test('marker code is read RAW — normalising trashes the v1.146 collision-pair markers', () => {
  assert.equal(markerCodeFromFilename('_SHOOT-NWS-260701-L-01.txt'), 'NWS-260701-L-01')
  assert.equal(markerCodeFromFilename('_SHOOT-AGN-260423-EVT-01.txt'), 'AGN-260423-EVT-01')
  assert.equal(markerCodeFromFilename('_SHOOT.txt'), null)
  assert.equal(markerCodeFromFilename('clip.mp4'), null)
})

test('Buddhist-year detection is LINE-ANCHORED — unanchored caused a nightly rewrite loop', () => {
  assert.equal(markerDateHasBuddhistYear('วันถ่าย: 17 ส.ค. 2569'), true)
  assert.equal(markerDateHasBuddhistYear('Shoot date: 2569-08-17'), true)
  assert.equal(markerDateHasBuddhistYear('วันถ่าย: 2026-08-17'), false)
  // A 25xx elsewhere in the file must NOT trigger a rewrite (v1.134 loop).
  assert.equal(markerDateHasBuddhistYear('วันถ่าย: 2026-08-17\nโน้ต: ห้อง 2569'), false)
  assert.equal(markerDateHasBuddhistYear(''), false)
})

// ── emptiness ───────────────────────────────────────────────────────────────

test('an unrecognised file counts as REAL content — the fail-safe direction', () => {
  assert.equal(isRealContentFile('A001.MXF'), true)
  assert.equal(isRealContentFile('_SHOOTLIST.txt'), true)   // crew's file, not ours
  assert.equal(isRealContentFile('_SHOOT-X.txt'), false)    // ours
  assert.equal(hasRealFiles(['_SHOOT.txt', '_SHOOT-A.txt']), false)
  assert.equal(hasRealFiles(['_SHOOT.txt', 'A001.MXF']), true)
  assert.equal(hasRealFiles([{ name: '_SHOOT.txt' }, { name: 'clip.mov' }]), true)
  assert.equal(hasRealFiles([]), false)
})

// ── landing ─────────────────────────────────────────────────────────────────

const D = (s: string) => new Date(s + 'T00:00:00.000Z')

test("TOMORROW's drop folder is never trashed — 'non-today' deleted it at 19:00", () => {
  const today = D('2026-08-07')
  assert.equal(landingMayBeTrashed({ lastShootDay: D('2026-08-08'), today, hasFiles: false }), false)
  assert.equal(landingMayBeTrashed({ lastShootDay: today, today, hasFiles: false }), false)
  assert.equal(landingMayBeTrashed({ lastShootDay: D('2026-08-06'), today, hasFiles: false }), true)
})

test('a folder with footage is NEVER trashed, however old', () => {
  const today = D('2026-08-07')
  assert.equal(landingMayBeTrashed({ lastShootDay: D('2026-01-01'), today, hasFiles: true }), false)
  assert.equal(landingMayBeTrashed({ lastShootDay: null, today, hasFiles: false }), false)
})

test('a multi-day shoot ages from its LAST day and covers every day in between', () => {
  const b = { shootDate: D('2026-08-05'), shootEndDate: D('2026-08-07') }
  assert.equal(lastShootDay(b).toISOString().slice(0, 10), '2026-08-07')
  assert.equal(lastShootDay({ shootDate: D('2026-08-05') }).toISOString().slice(0, 10), '2026-08-05')
  for (const d of ['2026-08-05', '2026-08-06', '2026-08-07']) {
    assert.equal(spanCoversDay(b, D(d)), true, d)
  }
  assert.equal(spanCoversDay(b, D('2026-08-04')), false)
  assert.equal(spanCoversDay(b, D('2026-08-08')), false)
  // and the day-3 folder is safe while the crew is still shooting day 1
  assert.equal(landingMayBeTrashed({ lastShootDay: lastShootDay(b), today: D('2026-08-05'), hasFiles: false }), false)
})

// ── probe ───────────────────────────────────────────────────────────────────

test("an unreadable Drive probe never reads as 'safe' — a 429 storm must not create or trash", () => {
  assert.equal(probeSaysSafeToCreate('out-of-tree'), true)
  assert.equal(probeSaysSafeToCreate('in-tree'), false)
  assert.equal(probeSaysSafeToCreate('unknown'), false)     // fail-closed
  assert.equal(probeBlocksDestructiveAction('unknown'), true)
  assert.equal(probeBlocksDestructiveAction('out-of-tree'), true)
  assert.equal(probeBlocksDestructiveAction('in-tree'), false)
})

// ── rename gates ────────────────────────────────────────────────────────────

test('only names WE generated may be renamed — ops-authored names are reported, not corrected', () => {
  const code = 'NWS-TWD-260817-01'
  assert.equal(isAppShapedFolderName(`The World Dialogue · Job (${code})`, code), true)
  assert.equal(isAppShapedFolderName(`${code} · Job`, code), true)   // pre-v1.110 shape
  assert.equal(isAppShapedFolderName(code, code), true)
  assert.equal(isAppShapedFolderName('ห้ามแตะ งานพี่เต๋า', code), false)
  assert.equal(isAppShapedFolderName('', code), false)
  assert.equal(isAppShapedFolderName(`x (${code})`, 'OTHER-01'), false)
})

test('EP names use the same rule, one predicate for one safety property', () => {
  assert.equal(isAppShapedEpName('NWS-TWD-260817-01', 'NWS-TWD-260817-01'), true)
  assert.equal(isAppShapedEpName('NWS-TWD-260817-01 · ตอนพิเศษ', 'NWS-TWD-260817-01'), true)
  assert.equal(isAppShapedEpName('ตอนพิเศษ', 'NWS-TWD-260817-01'), false)
})

// ── merge ───────────────────────────────────────────────────────────────────

test('same name AND size = duplicate: leave it, never overwrite or trash', () => {
  assert.equal(isDuplicateFile({ name: 'A001.MXF', size: 100 }, { name: 'A001.MXF', size: 100 }), true)
  assert.equal(isDuplicateFile({ name: 'A001.MXF', size: 100 }, { name: 'A001.MXF', size: 101 }), false)
  assert.equal(isDuplicateFile({ name: 'A001.MXF', size: 100 }, { name: 'A002.MXF', size: 100 }), false)
  // Drive returns size as a string — a strict === would have called these different.
  assert.equal(isDuplicateFile({ name: 'A.MXF', size: '100' }, { name: 'A.MXF', size: 100 }), true)
})

test('twins match on the IMMUTABLE lead, never fuzzily — the POP-PIV EP-split bug', () => {
  assert.equal(immutableLead('NWS-260817-01 · ชื่อเดิม'), 'NWS-260817-01')
  assert.equal(immutableLead('NWS-260817-01'), null)   // no separator → refuse to guess
  assert.equal(twinsMatch('NWS-260817-01 · ชื่อเดิม', 'NWS-260817-01 · ชื่อที่แก้แล้ว'), true)
  assert.equal(twinsMatch('NWS-260817-01 · a', 'NWS-260817-02 · a'), false)
  // A name with no lead must never match anything — that is what fuzzy did.
  assert.equal(twinsMatch('ชื่อมั่ว', 'ชื่อมั่ว'), false)
})
