import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffEditable, fmt } from '../producer-edit-fields'

test('no changes → empty diff', () => {
  const b = { callTime: '09:00', cameraCount: 2, needsVan: false, crewRequired: ['A', 'B'] }
  assert.deepEqual(diffEditable(b, { ...b }), {})
})

test('scalar change is detected with from/to', () => {
  const before = { callTime: '09:00' }
  const after = { callTime: '10:00' }
  assert.deepEqual(diffEditable(before, after), { callTime: { from: '09:00', to: '10:00' } })
})

test('array change is detected by content, not reference', () => {
  const before = { crewRequired: ['Videographer'] }
  const after = { crewRequired: ['Videographer', 'Sound'] }
  assert.ok('crewRequired' in diffEditable(before, after))
})

test('reordered-but-equal array still flags (content compare is order-sensitive)', () => {
  // order matters for crew display, so a reorder is a real change
  const d = diffEditable({ crewRequired: ['A', 'B'] }, { crewRequired: ['B', 'A'] })
  assert.ok('crewRequired' in d)
})

test('null vs empty-string vs undefined are treated as equal (no noise)', () => {
  assert.deepEqual(diffEditable({ locationName: null }, { locationName: '' }), {})
  assert.deepEqual(diffEditable({ agencyRef: undefined }, { agencyRef: null }), {})
})

test('boolean needsVan change detected', () => {
  assert.deepEqual(diffEditable({ needsVan: false }, { needsVan: true }), { needsVan: { from: false, to: true } })
})

test('non-whitelisted fields are ignored', () => {
  // status is admin-only and not in FIELD_LABELS — a change must NOT appear
  assert.deepEqual(diffEditable({ status: 'REQUESTED' }, { status: 'CONFIRMED' }), {})
})

test('fmt renders arrays, booleans, and empties', () => {
  assert.equal(fmt(['A', 'B']), 'A, B')
  assert.equal(fmt([]), '—')
  assert.equal(fmt(true), 'ใช่')
  assert.equal(fmt(''), '—')
  assert.equal(fmt(null), '—')
  assert.equal(fmt(3), '3')
})
