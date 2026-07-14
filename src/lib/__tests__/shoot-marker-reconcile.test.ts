/**
 * _SHOOT marker reconciler — pure helpers (v1.135).
 * The Drive I/O is integration-tested by the dry-run endpoint; here we lock down
 * the two pure functions the trash/keep decision hinges on: pulling a Production
 * ID out of a marker filename, and normalizing a legacy [TYPE] id to the DB form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idFromMarkerName, parseMarkerProductionId, markerDateHasBuddhistYear, resolveMarkerCode } from '../shoot-marker-reconcile'
import { computeTypeDroppedId } from '../id-migration'

test('idFromMarkerName pulls the Production ID out of a box-level marker name', () => {
  assert.equal(idFromMarkerName('_SHOOT-AGN-260708-LOC-01.txt'), 'AGN-260708-LOC-01')
  assert.equal(idFromMarkerName('_SHOOT-AGN-260708-01.txt'), 'AGN-260708-01')
  assert.equal(idFromMarkerName('_SHOOT-AGN-690702-LOC-01.txt'), 'AGN-690702-LOC-01')
})

test('idFromMarkerName returns null for a bare _SHOOT.txt (no id in the name)', () => {
  assert.equal(idFromMarkerName('_SHOOT.txt'), null)
})

test('a TYPE-bearing legacy id normalizes to the same typeless DB code as the current booking', () => {
  // This is the whole point: the box-level "AGN-260708-LOC-01" marker must resolve
  // to the DB's typeless "AGN-260708-01" so the reconciler recognizes it as the
  // SAME shoot and trashes it as a duplicate.
  const normalize = (id: string) => (computeTypeDroppedId(id) ?? id).toUpperCase()
  assert.equal(normalize('AGN-260708-LOC-01'), 'AGN-260708-01')
  assert.equal(normalize('AGN-260707-STD-01'), 'AGN-260707-01')
  assert.equal(normalize('AGN-690702-LOC-01'), 'AGN-690702-01') // year stays; TYPE dropped
})

test('an already-typeless id normalizes to itself (idempotent)', () => {
  const normalize = (id: string) => (computeTypeDroppedId(id) ?? id).toUpperCase()
  assert.equal(normalize('AGN-260708-01'), 'AGN-260708-01')
})

// ── content audit helpers ─────────────────────────────────────────────────
const MARKER = `════════════════════════════════════
  _SHOOT.txt — ข้อมูลงานถ่ายทำ / Shoot info
════════════════════════════════════

Production ID     : AGN-260708-01
งาน / Project     : GWM Brand Trust
Outlet            : Content Agency (AGN)

── วันถ่ายทำ / Schedule ─────────────
วันที่ / Date      : 8 ก.ค. 2026
เวลา / Time       : 10:00 → 18:00
`

test('parseMarkerProductionId reads the Production ID line from marker content', () => {
  assert.equal(parseMarkerProductionId(MARKER), 'AGN-260708-01')
  assert.equal(parseMarkerProductionId('no id here'), null)
  assert.equal(parseMarkerProductionId('Production ID : AGN-690702-LOC-01\n'), 'AGN-690702-LOC-01')
})

test('markerDateHasBuddhistYear flags Buddhist-era years on the date line', () => {
  assert.equal(markerDateHasBuddhistYear(MARKER), false) // 2026 = Gregorian → clean
  assert.equal(markerDateHasBuddhistYear('วันที่ / Date      : 8 ก.ค. 2569\n'), true) // single Buddhist
  assert.equal(markerDateHasBuddhistYear('วันที่ / Date      : 2 ก.ค. 3112\n'), true) // double-converted
})

test('markerDateHasBuddhistYear ignores a Gregorian year that appears in an ID line', () => {
  // a 2026-style year in the Production ID must not trip the date check
  assert.equal(markerDateHasBuddhistYear('Production ID : AGN-260708-01\nวันที่ / Date : 8 ก.ค. 2026'), false)
})

// ── resolveMarkerCode (v1.146) — raw-id-first resolution for collision pairs ─

test('resolveMarkerCode: a live collision-pair legacy [TYPE] code resolves to ITSELF, not its normalized form', () => {
  // AGN-260703-STD-01 is a real bookingCode the v1.109 migration kept — the
  // marker must resolve to it (staying "live"), not to AGN-260703-01 (which
  // matches nothing → the old code trashed the live booking's marker as stale).
  const live = ['AGN-260703-STD-01', 'AGN-260703-LOC-01']
  assert.equal(resolveMarkerCode('AGN-260703-STD-01', live), 'AGN-260703-STD-01')
  assert.equal(resolveMarkerCode('agn-260703-loc-01', live), 'AGN-260703-LOC-01')
})

test('resolveMarkerCode: a migrated booking still normalizes its legacy marker id', () => {
  // Booking migrated to the typeless code; a stale marker still carrying the
  // old [TYPE] id must normalize so it matches the live code.
  assert.equal(resolveMarkerCode('AGN-260708-LOC-01', ['AGN-260708-01']), 'AGN-260708-01')
})

test('resolveMarkerCode: a genuinely dead id normalizes and matches nothing (stays stale)', () => {
  assert.equal(resolveMarkerCode('AGN-250101-STD-01', ['AGN-260708-01']), 'AGN-250101-01')
})
