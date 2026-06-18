import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveEquipmentStatus } from '../equipment-status'

// Precedence: RETIRED (manual terminal) > IN_REPAIR > ON_LOAN > AVAILABLE.
test('RETIRED is terminal — never auto-changed regardless of loans/repairs', () => {
  assert.equal(deriveEquipmentStatus('RETIRED', { hasOpenRepair: true, hasActiveLoan: true }), 'RETIRED')
  assert.equal(deriveEquipmentStatus('RETIRED', { hasOpenRepair: false, hasActiveLoan: false }), 'RETIRED')
})

test('open repair wins over an active loan (item is at the vendor)', () => {
  assert.equal(deriveEquipmentStatus('ON_LOAN', { hasOpenRepair: true, hasActiveLoan: true }), 'IN_REPAIR')
  assert.equal(deriveEquipmentStatus('AVAILABLE', { hasOpenRepair: true, hasActiveLoan: false }), 'IN_REPAIR')
})

test('active loan with no open repair → ON_LOAN', () => {
  assert.equal(deriveEquipmentStatus('AVAILABLE', { hasOpenRepair: false, hasActiveLoan: true }), 'ON_LOAN')
  // returning one of two loans: still has an active loan → stays ON_LOAN (not wrongly freed)
  assert.equal(deriveEquipmentStatus('ON_LOAN', { hasOpenRepair: false, hasActiveLoan: true }), 'ON_LOAN')
})

test('no open repair and no active loan → AVAILABLE', () => {
  assert.equal(deriveEquipmentStatus('ON_LOAN', { hasOpenRepair: false, hasActiveLoan: false }), 'AVAILABLE')
  assert.equal(deriveEquipmentStatus('IN_REPAIR', { hasOpenRepair: false, hasActiveLoan: false }), 'AVAILABLE')
})
