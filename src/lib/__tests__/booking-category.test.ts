/**
 * deriveBookingCategory (v1.98.0) — booking-level Category resolution after the
 * non-AGN radio was removed in favor of per-episode contentType.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveBookingCategory } from '../booking-category'

test('non-AGN: any Advertorial episode → ADVERTORIAL', () => {
  assert.equal(
    deriveBookingCategory(false, 'ORIGINAL_CONTENT', [
      { contentType: 'ORIGINAL_CONTENT' },
      { contentType: 'ADVERTORIAL' },
    ]),
    'ADVERTORIAL',
  )
})

test('non-AGN: all Original Content → ORIGINAL_CONTENT', () => {
  assert.equal(
    deriveBookingCategory(false, 'ADVERTORIAL', [
      { contentType: 'ORIGINAL_CONTENT' },
      { contentType: 'ORIGINAL_CONTENT' },
    ]),
    'ORIGINAL_CONTENT', // explicit ADVERTORIAL ignored for non-AGN — derived from EPs
  )
})

test('non-AGN: no episodes → ORIGINAL_CONTENT (safe default, never null)', () => {
  assert.equal(deriveBookingCategory(false, 'EVENT', []), 'ORIGINAL_CONTENT')
})

test('AGN: keeps the explicit category (drives folder routing), ignores episodes', () => {
  assert.equal(deriveBookingCategory(true, 'EVENT', []), 'EVENT')
  assert.equal(deriveBookingCategory(true, 'ADVERTORIAL', [{ contentType: 'ORIGINAL_CONTENT' }]), 'ADVERTORIAL')
})
