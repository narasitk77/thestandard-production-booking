/**
 * _SHOOT marker reconciler — pure helpers (v1.135).
 * The Drive I/O is integration-tested by the dry-run endpoint; here we lock down
 * the two pure functions the trash/keep decision hinges on: pulling a Production
 * ID out of a marker filename, and normalizing a legacy [TYPE] id to the DB form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idFromMarkerName } from '../shoot-marker-reconcile'
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
