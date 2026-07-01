/**
 * Episode / Production ID format tests (run: npm test).
 *
 * v1.109 rule: the ID is [OUT]-[PROG]-[YYMMDD]-[NN] — the [TYPE] segment
 * (Episode Type L/S/A/T · Shoot Type STD/LOC/EVT) was dropped. Every OLDER ID
 * that still carries a [TYPE] (`NWS-KYM-260616-L-01`, `AGN-260423-EVT-01`,
 * `NWS-260608-L-03`) must keep parsing, because footage folders + existing
 * bookings still use it until the data migration renames them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateEpisodeId,
  parseEpisodeId,
  EPISODE_ID_RE,
  EPISODE_ID_RE_LOOSE,
} from '../episode-id'
import { parseProductionId, looksLikeProductionId } from '../production-id'

const SHOOT = new Date(2026, 5, 16) // 16 Jun 2026

test('generateEpisodeId with a program code → [OUT]-[PROG]-[YYMMDD]-[NN] (no type)', () => {
  assert.equal(generateEpisodeId('NWS', SHOOT, 1, 'KYM'), 'NWS-KYM-260616-01')
  assert.equal(generateEpisodeId('NWS', SHOOT, 12, 'eng'), 'NWS-ENG-260616-12')
})

test('generateEpisodeId without a program code → [OUT]-[YYMMDD]-[NN]', () => {
  assert.equal(generateEpisodeId('AGN', SHOOT, 1), 'AGN-260616-01')
  assert.equal(generateEpisodeId('NWS', SHOOT, 3, null), 'NWS-260616-03')
  assert.equal(generateEpisodeId('NWS', SHOOT, 3, '  '), 'NWS-260616-03')
})

test('generated IDs no longer contain the L/S/A/T type segment', () => {
  // regression guard for the ops request: WLT-EXI-260701-L-01 → WLT-EXI-260701-01
  assert.equal(generateEpisodeId('WLT', new Date(2026, 6, 1), 1, 'EXI'), 'WLT-EXI-260701-01')
})

test('strict parse: NEW format with program (typeCode null)', () => {
  const p = parseEpisodeId('NWS-KYM-260616-01')
  assert.ok(p)
  assert.equal(p.outletCode, 'NWS')
  assert.equal(p.programCode, 'KYM')
  assert.equal(p.typeCode, null)
  assert.equal(p.sequence, 1)
  assert.equal(p.dateStr, '260616')
})

test('strict parse: NEW format without program (AGN)', () => {
  const p = parseEpisodeId('AGN-260423-07')
  assert.ok(p)
  assert.equal(p.outletCode, 'AGN')
  assert.equal(p.programCode, null)
  assert.equal(p.typeCode, null)
  assert.equal(p.sequence, 7)
})

test('backward-compat parse: OLD format with type + program', () => {
  const p = parseEpisodeId('NWS-KYM-260616-L-01')
  assert.ok(p)
  assert.equal(p.outletCode, 'NWS')
  assert.equal(p.programCode, 'KYM')
  assert.equal(p.typeCode, 'L')
  assert.equal(p.sequence, 1)
})

test('backward-compat parse: OLD format with type, no program', () => {
  const p = parseEpisodeId('AGN-260423-EVT-01')
  assert.ok(p)
  assert.equal(p.outletCode, 'AGN')
  assert.equal(p.programCode, null)
  assert.equal(p.typeCode, 'EVT')
  assert.equal(p.sequence, 1)
})

test('sequence is read correctly from both shapes (drives collision-free numbering)', () => {
  // The seq computation in create-booking maxes parseEpisodeId(...).sequence over
  // both old and new IDs for the same outlet+program+date — verify both parse.
  assert.equal(parseEpisodeId('WLT-EXI-260701-L-02')?.sequence, 2) // old
  assert.equal(parseEpisodeId('WLT-EXI-260701-03')?.sequence, 3)   // new
})

test('strict regex rejects near-misses', () => {
  for (const bad of [
    'NWS-K-260616-01',        // 1-char program segment
    'NWS-KYMXX-260616-01',    // 5-char program segment
    'nws-kym-260616-01',      // lowercase
    'NWS-KYM-2606-01',        // short date
    'NWS-KYM-260616-1',       // 1-digit sequence
  ]) {
    assert.equal(EPISODE_ID_RE.test(bad), false, `${bad} must not parse`)
  }
})

test('loose extraction pulls both old and new shapes out of folder names', () => {
  assert.equal(parseProductionId('[Final] AGN-260423-EVT-01 master'), 'AGN-260423-EVT-01') // old
  assert.equal(parseProductionId('กล้อง A — WLT-EXI-260701-01_card1'), 'WLT-EXI-260701-01') // new
})

test('loose extraction captures the FULL new-format ID, not the tail after the outlet', () => {
  const m = 'NWS-KYM-260616-01'.match(EPISODE_ID_RE_LOOSE)
  assert.ok(m)
  assert.equal(m[1], 'NWS-KYM-260616-01')
})

test('loose extraction captures the FULL old-format ID (type kept)', () => {
  const m = 'NWS-KYM-260616-L-01'.match(EPISODE_ID_RE_LOOSE)
  assert.ok(m)
  assert.equal(m[1], 'NWS-KYM-260616-L-01')
})

test('loose boundaries: 3-digit sequence rejected on both shapes', () => {
  assert.equal(parseProductionId('NWS-KYM-260616-100'), null)   // new
  assert.equal(parseProductionId('NWS-KYM-260616-L-100'), null) // old
})

test('looksLikeProductionId flags a lowercase new-format ID as a case typo', () => {
  assert.equal(looksLikeProductionId('nws-kym-260616-01'), 'NWS-KYM-260616-01')
})
