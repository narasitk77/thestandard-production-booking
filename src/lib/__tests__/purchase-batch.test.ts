import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBatchEditable, lineTotal, batchTotal, safeFolderSegment } from '../purchase-batch'

test('isBatchEditable: only DRAFT and REJECTED are editable', () => {
  assert.equal(isBatchEditable('DRAFT'), true)
  assert.equal(isBatchEditable('REJECTED'), true)
  assert.equal(isBatchEditable('SUBMITTED'), false)
  assert.equal(isBatchEditable('APPROVED'), false)
})

test('lineTotal: explicit total wins, else qty × unitPrice, else 0', () => {
  assert.equal(lineTotal({ total: 1200 }), 1200)
  assert.equal(lineTotal({ quantity: 3, unitPrice: 100 }), 300)
  assert.equal(lineTotal({ unitPrice: 100 }), 100) // qty defaults to 1
  assert.equal(lineTotal({ item: 'x' } as never), 0)
  // explicit total of 0 is respected, not treated as "missing"
  assert.equal(lineTotal({ total: 0, unitPrice: 999 }), 0)
})

test('batchTotal: sums line amounts across mixed shapes', () => {
  assert.equal(
    batchTotal([{ total: 1200 }, { quantity: 2, unitPrice: 50 }, { unitPrice: 80 }]),
    1380,
  )
  assert.equal(batchTotal([]), 0)
})

test('safeFolderSegment: strips slashes, trims, caps, falls back', () => {
  assert.equal(safeFolderSegment('SD Card / 128GB', 'x'), 'SD Card - 128GB')
  assert.equal(safeFolderSegment('   ', 'fallback-id'), 'fallback-id')
})
