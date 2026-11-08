import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decOrNull, intOr, InvalidMoneyError } from '../admin-parse'

test('decOrNull: parses money, rejects negatives + overflow', () => {
  assert.equal(decOrNull('1200'), '1200')
  assert.equal(decOrNull('1,200.50'), '1200.5')
  assert.equal(decOrNull(99.99), '99.99')
  assert.equal(decOrNull(''), null)
  assert.equal(decOrNull(null), null)
  // negatives are invalid for money fields → refused (was '-500' before the first fix,
  // then null — which every PATCH route wrote over the stored amount with a 200;
  // maintenance 2026-11-08: refused LOUDLY so nothing is overwritten)
  assert.throws(() => decOrNull('-500'), InvalidMoneyError)
  assert.throws(() => decOrNull('-0.01'), InvalidMoneyError)
  // over the Decimal(12,2) ceiling → refused here instead of a Prisma 500
  assert.throws(() => decOrNull('12345678901234'), InvalidMoneyError)
  assert.equal(decOrNull('9999999999.99'), '9999999999.99')
})

test('decOrNull: a value that was sent but is not a number is an error, not "no amount"', () => {
  assert.throws(() => decOrNull('1.2.3'), /ยอดเงินไม่ถูกต้อง/)
  // nothing numeric at all still means "no amount" (sheet cells like 'N/A' / 'ฟรี')
  assert.equal(decOrNull('N/A'), null)
  assert.equal(decOrNull('-'), null)
})

test('intOr: clamps to a finite int with fallback', () => {
  assert.equal(intOr('3', 1), 3)
  assert.equal(intOr('', 1), 1)
  assert.equal(intOr('abc', 1), 1)
})
