/**
 * Type-drop ID migration — pure logic tests (run: npm test).
 *
 * v1.109 drops the [TYPE] segment from Production/Episode IDs. The dangerous case
 * is two IDs that differ ONLY in that segment collapsing to the same code — since
 * Booking.bookingCode is @unique, the planner must detect those and LEAVE them
 * untouched (the "colliding pairs" the ops team keeps).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTypeDroppedId, planTypeDropMigration, type MigrationPlanInput } from '../id-migration'

// ── computeTypeDroppedId ─────────────────────────────────────────────────────

test('computeTypeDroppedId drops the type, keeps outlet/program/date/seq', () => {
  assert.equal(computeTypeDroppedId('NWS-260701-L-01'), 'NWS-260701-01')
  assert.equal(computeTypeDroppedId('NWS-KYM-260616-L-01'), 'NWS-KYM-260616-01')
  assert.equal(computeTypeDroppedId('AGN-260529-STD-01'), 'AGN-260529-01')
  assert.equal(computeTypeDroppedId('AGN-260423-EVT-01'), 'AGN-260423-01')
  assert.equal(computeTypeDroppedId('WLT-EXI-260701-L-01'), 'WLT-EXI-260701-01')
})

test('computeTypeDroppedId returns null when there is nothing to drop', () => {
  assert.equal(computeTypeDroppedId('NWS-260701-01'), null)      // already type-less
  assert.equal(computeTypeDroppedId('NWS-KYM-260616-01'), null)  // already type-less
  assert.equal(computeTypeDroppedId('PP-26-008-L04'), null)      // not our format (AGN project ep)
  assert.equal(computeTypeDroppedId('garbage'), null)
  assert.equal(computeTypeDroppedId(''), null)
})

test('computeTypeDroppedId preserves a multi-digit sequence', () => {
  assert.equal(computeTypeDroppedId('NWS-260701-L-12'), 'NWS-260701-12')
  assert.equal(computeTypeDroppedId('NWS-KYM-260616-S-09'), 'NWS-KYM-260616-09')
})

// ── planTypeDropMigration ────────────────────────────────────────────────────

const bk = (id: string, bookingCode: string | null, episodes: Array<[string, string]> = []): MigrationPlanInput => ({
  id,
  bookingCode,
  episodes: episodes.map(([eid, episodeId]) => ({ id: eid, episodeId })),
})

test('plan: independent bookings each migrate (bookingCode + episode[0] together)', () => {
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-260701-L-01', [['e1', 'NWS-260701-L-01']]),
    bk('b2', 'NWS-KYM-260616-L-01', [['e2', 'NWS-KYM-260616-L-01']]),
  ])
  assert.equal(plan.toApply.length, 2)
  assert.equal(plan.collisions.length, 0)
  const b1 = plan.toApply.find(e => e.bookingId === 'b1')!
  assert.equal(b1.newCode, 'NWS-260701-01')
  assert.deepEqual(b1.episodeChanges, [{ episodeDbId: 'e1', oldEpisodeId: 'NWS-260701-L-01', newEpisodeId: 'NWS-260701-01' }])
})

test('plan: a colliding PAIR (differ only by type) is excluded and reported', () => {
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-260701-L-01', [['e1', 'NWS-260701-L-01']]),
    bk('b2', 'NWS-260701-S-01', [['e2', 'NWS-260701-S-01']]),
  ])
  assert.equal(plan.toApply.length, 0, 'neither side of a collision is migrated')
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].finalCode, 'NWS-260701-01')
  assert.equal(plan.collisions[0].members.length, 2)
  assert.ok(plan.collisions[0].members.every(m => m.wouldChange))
})

test('plan: new code colliding with an EXISTING type-less booking is excluded', () => {
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-260701-L-01', [['e1', 'NWS-260701-L-01']]), // → NWS-260701-01
    bk('b2', 'NWS-260701-01', [['e2', 'NWS-260701-01']]),     // already that code, no type
  ])
  assert.equal(plan.toApply.length, 0)
  assert.equal(plan.unchanged.includes('b2'), true)
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].finalCode, 'NWS-260701-01')
})

test('plan: type-less bookings are left unchanged (not applied, not collisions)', () => {
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-260701-01', [['e1', 'NWS-260701-01']]),
    bk('b2', 'NWS-KYM-260616-02', [['e2', 'NWS-KYM-260616-02']]),
  ])
  assert.equal(plan.toApply.length, 0)
  assert.equal(plan.collisions.length, 0)
  assert.deepEqual(plan.unchanged.sort(), ['b1', 'b2'])
})

test('plan: multi-episode non-AGN booking migrates every typed episode', () => {
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-KYM-260616-L-01', [
      ['e1', 'NWS-KYM-260616-L-01'],
      ['e2', 'NWS-KYM-260616-L-02'],
    ]),
  ])
  const b1 = plan.toApply.find(e => e.bookingId === 'b1')!
  assert.equal(b1.newCode, 'NWS-KYM-260616-01')
  assert.equal(b1.episodeChanges.length, 2)
  assert.deepEqual(
    b1.episodeChanges.map(c => c.newEpisodeId).sort(),
    ['NWS-KYM-260616-01', 'NWS-KYM-260616-02'],
  )
})

test('plan: AGN booking migrates its code but NOT its project episodes', () => {
  // AGN bookingCode carries a shoot type (STD); its episodes are project episode
  // IDs (PP-…) that don't match our format → they must be left alone.
  const plan = planTypeDropMigration([
    bk('agn1', 'AGN-260529-STD-01', [
      ['pe1', 'PP-26-008-L04'],
      ['pe2', 'PP-26-009-L01'],
    ]),
  ])
  const e = plan.toApply.find(x => x.bookingId === 'agn1')!
  assert.equal(e.newCode, 'AGN-260529-01')
  assert.equal(e.episodeChanges.length, 0, 'project episode IDs are untouched')
})

test('plan: surfaces a post-migration duplicate episodeId as a warning (not a block)', () => {
  // Two DIFFERENT bookings whose typed episodes collapse to the same episodeId.
  // bookingCodes differ (KYM vs ENG) so no bookingCode collision — but the
  // episode ids would both become NWS-260701-01-ish. Contrived to exercise the warn.
  const plan = planTypeDropMigration([
    bk('b1', 'NWS-KYM-260701-L-01', [['e1', 'NWS-KYM-260701-L-01']]),
    bk('b2', 'NWS-ENG-260701-L-01', [['e2', 'NWS-ENG-260701-L-01'], ['e3', 'NWS-KYM-260701-S-01']]),
  ])
  // both bookings migrate (distinct bookingCodes)
  assert.equal(plan.toApply.length, 2)
  // e1 → NWS-KYM-260701-01 and e3 (NWS-KYM-260701-S-01) → NWS-KYM-260701-01 : duplicate
  const warn = plan.episodeIdWarnings.find(w => w.episodeId === 'NWS-KYM-260701-01')
  assert.ok(warn, 'duplicate episodeId is flagged')
  assert.equal(warn!.count, 2)
})

test('plan: null bookingCode is ignored safely', () => {
  const plan = planTypeDropMigration([
    bk('b1', null, [['e1', 'NWS-260701-L-01']]),
  ])
  assert.equal(plan.toApply.length, 0)
  assert.equal(plan.unchanged.includes('b1'), true)
  assert.equal(plan.collisions.length, 0)
})
