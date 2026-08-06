// v1.163 — ย้ายสังกัด. These pin the parts that decide whether a move is SAFE:
// the ID recompute against the target outlet, every refusal, the relocation
// predicate (the v1.109 one compared the program folder only, so a cross-outlet
// move could silently skip the move), and the retry guard.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  progSegmentForId, boxNeedsRelocation, boxNameAcceptable,
  computeOutletMoveIds, moveStreamPrefixes, validateOutletMove, movePaths,
} from '../move-outlet'

const shoot = new Date('2026-08-17T00:00:00.000Z')
const EP = (id: string, episodeId: string, code: string | null) =>
  ({ id, episodeId, program: code ? { code } : null })

// ── ID recompute ─────────────────────────────────────────────────────────────

test('the real case: PM-PMG → NWS-TWD picks the next free sequence in the TARGET stream', () => {
  const { newBookingCode, episodeChanges } = computeOutletMoveIds({
    targetOutletCode: 'NWS', targetBookingProgramCode: 'L', shootDate: shoot,
    episodes: [{ id: 'e1', episodeId: 'PM-PMG-260817-01', targetProgramCode: 'TWD' }],
    priorByPrefix: { 'NWS-TWD-260817-': [] },
    movingEpisodeDbIds: new Set(['e1']),
  })
  assert.equal(newBookingCode, 'NWS-TWD-260817-01')
  assert.deepEqual(episodeChanges, [{ episodeDbId: 'e1', oldEpisodeId: 'PM-PMG-260817-01', newEpisodeId: 'NWS-TWD-260817-01' }])
})

test('an occupied target stream is stepped over, and the mover never inflates its own sequence', () => {
  const { newBookingCode } = computeOutletMoveIds({
    targetOutletCode: 'NWS', targetBookingProgramCode: 'L', shootDate: shoot,
    episodes: [{ id: 'e1', episodeId: 'PM-PMG-260817-01', targetProgramCode: 'TWD' }],
    priorByPrefix: {
      'NWS-TWD-260817-': [
        { id: 'other', episodeId: 'NWS-TWD-260817-01' },
        { id: 'other2', episodeId: 'NWS-TWD-260817-02' },
        { id: 'e1', episodeId: 'NWS-TWD-260817-09' }, // a prior half-applied attempt: must NOT count
      ],
    },
    movingEpisodeDbIds: new Set(['e1']),
  })
  assert.equal(newBookingCode, 'NWS-TWD-260817-03')
})

test('multi-episode: each episode takes its own slot, no duplicates', () => {
  const { episodeChanges } = computeOutletMoveIds({
    targetOutletCode: 'NWS', targetBookingProgramCode: 'L', shootDate: shoot,
    episodes: [
      { id: 'a', episodeId: 'PM-PMG-260817-01', targetProgramCode: 'TWD' },
      { id: 'b', episodeId: 'PM-PMG-260817-02', targetProgramCode: 'TWD' },
    ],
    priorByPrefix: { 'NWS-TWD-260817-': [] },
    movingEpisodeDbIds: new Set(['a', 'b']),
  })
  const ids = episodeChanges.map(c => c.newEpisodeId)
  assert.deepEqual(ids, ['NWS-TWD-260817-01', 'NWS-TWD-260817-02'])
  assert.equal(new Set(ids).size, 2)
})

test('progSegmentForId matches create-booking: dropped when it equals the Episode Type', () => {
  assert.equal(progSegmentForId('TWD', 'L'), 'TWD')
  assert.equal(progSegmentForId('L', 'L'), null)      // same as booking-level → no segment
  assert.equal(progSegmentForId('toolong', 'L'), null)
  assert.equal(progSegmentForId('twd', 'l'), 'TWD')   // case-insensitive both sides
  assert.deepEqual(moveStreamPrefixes({
    targetOutletCode: 'NWS', targetBookingProgramCode: 'L', shootDate: shoot, targetProgramCodes: ['TWD', 'TWD', 'L'],
  }).sort(), ['NWS-260817-', 'NWS-TWD-260817-'])
})

// ── the relocation predicate ────────────────────────────────────────────────

test('boxNeedsRelocation: a differing OUTLET counts even when the show folder matches', () => {
  // The v1.109 bug this guards: comparing only programFolder made a cross-outlet
  // move with an identical show name look like "already in the right place".
  assert.equal(boxNeedsRelocation(
    { outletCanon: '11 · PM', programFolder: 'The World Dialogue' },
    { outletCanon: '01 · News', programFolder: 'The World Dialogue' }), true)
  assert.equal(boxNeedsRelocation(
    { outletCanon: '01 · News', programFolder: 'A' },
    { outletCanon: '01 · News', programFolder: 'B' }), true)
  assert.equal(boxNeedsRelocation(
    { outletCanon: '01 · News', programFolder: 'A' },
    { outletCanon: '01 · News', programFolder: 'A' }), false)
})

test('movePaths derives BOTH sides from their own outlet code', () => {
  const p = movePaths({
    oldOutletCode: 'PM', newOutletCode: 'NWS',
    oldShowName: 'Project / Production', newShowName: 'The World Dialogue',
    oldCode: 'PM-PMG-260817-01', newCode: 'NWS-TWD-260817-01',
    jobName: 'The world dialogue', category: 'ORIGINAL_CONTENT', projectId: null, projectName: null,
  })
  assert.notEqual(p.oldOutletCanon, p.newOutletCanon)
  assert.match(p.newOutletCanon, /News/)
  assert.match(p.oldOutletCanon, /PM/)
  assert.equal(p.needsMove, true)
  assert.match(p.newLayers.bookingFolderName, /NWS-TWD-260817-01/)
  assert.match(p.oldLayers.bookingFolderName, /PM-PMG-260817-01/)
})

// ── retry guard ─────────────────────────────────────────────────────────────

test('boxNameAcceptable accepts the NEW code so a half-applied move stays retryable', () => {
  const oldC = 'PM-PMG-260817-01', newC = 'NWS-TWD-260817-01'
  assert.equal(boxNameAcceptable(`Project Production · x (${oldC})`, oldC, newC), true)
  assert.equal(boxNameAcceptable(`The World Dialogue · x (${newC})`, oldC, newC), true)
  assert.equal(boxNameAcceptable('Someone else · y (NWS-KYM-260817-01)', oldC, newC), false)
})

// ── refusals ────────────────────────────────────────────────────────────────

const base = {
  bookingCode: 'PM-PMG-260817-01', deletedAt: null, status: 'CONFIRMED', deliveredAt: null,
  projectId: null, outletCode: 'PM', program: { code: 'L' },
  episodes: [EP('e1', 'PM-PMG-260817-01', 'PMG')],
}

test('the happy path validates and auto-carries the current show code', () => {
  const r = validateOutletMove({ ...base, episodes: [EP('e1', 'PM-PMG-260817-01', 'KYM')] }, 'NWS', {})
  assert.equal(r.ok, true)
  assert.deepEqual((r as any).resolved, [{ id: 'e1', code: 'KYM' }]) // KYM exists in NWS → carried
})

test('an explicit pick overrides the carried code', () => {
  const r = validateOutletMove(base, 'NWS', { e1: 'TWD' })
  assert.deepEqual((r as any).resolved, [{ id: 'e1', code: 'TWD' }])
})

test('a show that does not exist in the target outlet is refused, naming the episode', () => {
  const r = validateOutletMove(base, 'NWS', {}) as { ok: false; error: string }
  assert.equal(r.ok, false)
  assert.match(r.error, /PMG/)          // PMG is a PM show, not a NWS one
  assert.match(r.error, /PM-PMG-260817-01/)
})

test('AGN is refused on both sides, delivered work is refused, project bookings are refused', () => {
  for (const [b, t, re] of [
    [{ ...base, outletCode: 'AGN' }, 'NWS', /Content Agency/],
    [base, 'AGN', /Content Agency/],
    [{ ...base, status: 'COMPLETED' }, 'NWS', /ส่งงานแล้ว/],
    [{ ...base, deliveredAt: new Date() }, 'NWS', /ส่งงานแล้ว/],
    [{ ...base, projectId: 'PP-26-001' }, 'NWS', /project/],
    [{ ...base, deletedAt: new Date() }, 'NWS', /ถูกลบ/],
    [{ ...base, bookingCode: null }, 'NWS', /ยังไม่มีเลข/],
    [base, 'PM', /สังกัดเดิม/],
    [base, 'ZZZ', /ไม่รู้จักสังกัด/],
  ] as const) {
    const r = validateOutletMove(b as any, t, { e1: 'TWD' }) as { ok: false; error: string }
    assert.equal(r.ok, false, `expected refusal for ${t}`)
    assert.match(r.error, re)
  }
})

test('photo-album bookings are refused (different shared drive)', () => {
  const r = validateOutletMove(
    { ...base, episodes: [EP('e1', 'PM-A-260817-01', 'A')] }, 'NWS', {}) as { ok: false; error: string }
  assert.equal(r.ok, false)
  assert.match(r.error, /Photo album/)
})
