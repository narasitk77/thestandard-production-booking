import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decOrNull, intOr } from '../admin-parse'

test('decOrNull: parses money, rejects negatives + overflow', () => {
  assert.equal(decOrNull('1200'), '1200')
  assert.equal(decOrNull('1,200.50'), '1200.5')
  assert.equal(decOrNull(99.99), '99.99')
  assert.equal(decOrNull(''), null)
  assert.equal(decOrNull(null), null)
  // negatives are invalid for money fields → null (was '-500' before the fix)
  assert.equal(decOrNull('-500'), null)
  assert.equal(decOrNull('-0.01'), null)
  // over the Decimal(12,2) ceiling → null instead of a Prisma 500
  assert.equal(decOrNull('12345678901234'), null)
  assert.equal(decOrNull('9999999999.99'), '9999999999.99')
})

test('intOr: clamps to a finite int with fallback', () => {
  assert.equal(intOr('3', 1), 3)
  assert.equal(intOr('', 1), 1)
  assert.equal(intOr('abc', 1), 1)
})
