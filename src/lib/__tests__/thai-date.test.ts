/**
 * Buddhist-era year normalization (v1.134) — the guard shared by the create
 * and edit paths so a pasted พ.ศ. year (2569) can't corrupt the shootDate or
 * the Production ID derived from it (getFullYear last-2 → "69" instead of "26").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBuddhistYear, BUDDHIST_ERA_OFFSET } from '../thai-date'

test('a Buddhist-era year (2569) is shifted back 543 to Gregorian (2026)', () => {
  const bud = new Date(Date.UTC(2569, 6, 2)) // 2 Jul "2569"
  const out = normalizeBuddhistYear(bud)!
  assert.equal(out.getUTCFullYear(), 2026)
  assert.equal(out.getUTCMonth(), 6)  // month/day preserved
  assert.equal(out.getUTCDate(), 2)
})

test('a normal Gregorian year is left untouched', () => {
  const greg = new Date(Date.UTC(2026, 6, 2))
  const out = normalizeBuddhistYear(greg)!
  assert.equal(out.getTime(), greg.getTime())
})

test('does not mutate the input Date', () => {
  const bud = new Date(Date.UTC(2569, 0, 1))
  normalizeBuddhistYear(bud)
  assert.equal(bud.getUTCFullYear(), 2569) // original unchanged
})

test('null / invalid pass through untouched', () => {
  assert.equal(normalizeBuddhistYear(null), null)
  assert.equal(normalizeBuddhistYear(undefined), undefined)
  const bad = new Date('nope')
  assert.ok(Number.isNaN(normalizeBuddhistYear(bad)!.getTime()))
})

test('the threshold is 2500 — 2499 stays, 2500 shifts', () => {
  assert.equal(normalizeBuddhistYear(new Date(Date.UTC(2499, 0, 1)))!.getUTCFullYear(), 2499)
  assert.equal(normalizeBuddhistYear(new Date(Date.UTC(2500, 0, 1)))!.getUTCFullYear(), 2500 - BUDDHIST_ERA_OFFSET)
})
