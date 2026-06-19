import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampCount, parseCount, stepCount, blurCount } from '../number-stepper'

test('parseCount: empty/invalid → null, digits → number', () => {
  assert.equal(parseCount(''), null)
  assert.equal(parseCount('abc'), null)
  assert.equal(parseCount('0'), 0)
  assert.equal(parseCount('12'), 12)
})

test('clampCount bounds', () => {
  assert.equal(clampCount(5, 0, 50), 5)
  assert.equal(clampCount(-3, 0, 50), 0)
  assert.equal(clampCount(99, 0, 50), 50)
})

test('stepCount from empty: +1 → first sensible count, −1 → min', () => {
  // camera/mic (min 0): + starts at 1, − at 0
  assert.equal(stepCount('', 1, 0, 50), '1')
  assert.equal(stepCount('', -1, 0, 50), '0')
  // videographer (min 1): both clamp to 1
  assert.equal(stepCount('', 1, 1, 10), '1')
  assert.equal(stepCount('', -1, 1, 10), '1')
})

test('stepCount nudges and clamps', () => {
  assert.equal(stepCount('2', 1, 0, 50), '3')
  assert.equal(stepCount('0', -1, 0, 50), '0') // can't go below min
  assert.equal(stepCount('10', 1, 1, 10), '10') // can't exceed max
})

test('blurCount: empty stays empty only when allowEmpty', () => {
  assert.equal(blurCount('', 0, 50, true), '') // camera/mic: keep empty for "required" validation
  assert.equal(blurCount('', 1, 10, false), '1') // videographer: snap to min
  assert.equal(blurCount('99', 0, 50, true), '50') // clamp over-max
  assert.equal(blurCount('3', 0, 50, true), '3')
})
