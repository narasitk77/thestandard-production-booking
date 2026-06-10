/**
 * Episode / Production ID format tests (run: npm test).
 *
 * v1.46.0 rule (ops feedback): the ID carries the show's program code
 * right after the outlet — `NWS-KYM-260616-L-01` — while every legacy ID
 * without the segment (`NWS-260608-L-01`, `AGN-260423-EVT-01`) must keep
 * parsing, because footage folders and old bookings still use it.
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

test('generateEpisodeId with a program code → [OUT]-[PROG]-[YYMMDD]-[TYPE]-[NN]', () => {
  assert.equal(generateEpisodeId('NWS', SHOOT, 'L', 1, 'KYM'), 'NWS-KYM-260616-L-01')
  assert.equal(generateEpisodeId('NWS', SHOOT, 'S', 12, 'eng'), 'NWS-ENG-260616-S-12')
})

test('generateEpisodeId without a program code keeps the legacy shape', () => {
  assert.equal(generateEpisodeId('AGN', SHOOT, 'STD', 1), 'AGN-260616-STD-01')
  assert.equal(generateEpisodeId('NWS', SHOOT, 'L', 3, null), 'NWS-260616-L-03')
  assert.equal(generateEpisodeId('NWS', SHOOT, 'L', 3, '  '), 'NWS-260616-L-03')
})

test('strict parse: new format', () => {
  const p = parseEpisodeId('NWS-KYM-260616-L-01')
  assert.ok(p)
  assert.equal(p.outletCode, 'NWS')
  assert.equal(p.programCode, 'KYM')
  assert.equal(p.typeCode, 'L')
  assert.equal(p.sequence, 1)
  assert.equal(p.dateStr, '260616')
})

test('strict parse: legacy format still valid, programCode = null', () => {
  const p = parseEpisodeId('AGN-260423-EVT-01')
  assert.ok(p)
  assert.equal(p.outletCode, 'AGN')
  assert.equal(p.programCode, null)
  assert.equal(p.typeCode, 'EVT')
  assert.equal(p.sequence, 1)
})

test('strict regex rejects near-misses', () => {
  for (const bad of [
    'NWS-K-260616-L-01',      // 1-char program segment is not emitted nor accepted
    'NWS-KYMXX-260616-L-01',  // 5-char program segment
    'nws-kym-260616-l-01',    // lowercase
    'NWS-KYM-2606-L-01',      // short date
  ]) {
    assert.equal(EPISODE_ID_RE.test(bad), false, `${bad} must not parse`)
  }
})

test('loose extraction pulls both shapes out of folder names', () => {
  assert.equal(parseProductionId('[Final] AGN-260423-EVT-01 master'), 'AGN-260423-EVT-01')
  assert.equal(parseProductionId('กล้อง A — NWS-KYM-260616-L-01_card1'), 'NWS-KYM-260616-L-01')
})

test('loose extraction captures the FULL new-format ID, not the tail after the outlet', () => {
  const m = 'NWS-KYM-260616-L-01'.match(EPISODE_ID_RE_LOOSE)
  assert.ok(m)
  assert.equal(m[1], 'NWS-KYM-260616-L-01')
})

test('loose boundaries still hold on the new format', () => {
  // 3-digit sequence is rejected, not truncated to -10
  assert.equal(parseProductionId('NWS-KYM-260616-L-100'), null)
  // Documented ambiguities (typo-class inputs, surfaced by footage triage
  // as unmatched IDs rather than silently wrong bookings):
  //  - 'XNWS-…' parses as the 4-letter outlet "XNWS" (same standing
  //    behavior as legacy 'XAGN-…').
  //  - a glued junk prefix ('XXNWS-…') blocks the real head, and the
  //    'KYM-260616-L-01' tail — indistinguishable from a legacy ID with
  //    outlet "KYM" — matches instead.
  assert.equal(parseProductionId('XXNWS-KYM-260616-L-01'), 'KYM-260616-L-01')
})

test('looksLikeProductionId flags a lowercase new-format ID as a case typo', () => {
  assert.equal(looksLikeProductionId('nws-kym-260616-l-01'), 'NWS-KYM-260616-L-01')
})
