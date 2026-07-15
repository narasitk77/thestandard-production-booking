/**
 * v1.147.3 — canonicalCameraName: the rename decision for the camera-folder
 * normalize sweep. Only EXACT variants rename; anything with extra text is
 * left alone (null).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalCameraName } from '../camera-folder-normalize'

test('cam variants → CAM-<LETTER>', () => {
  assert.equal(canonicalCameraName('Cam A'), 'CAM-A')
  assert.equal(canonicalCameraName('cam a'), 'CAM-A')
  assert.equal(canonicalCameraName('cam-b'), 'CAM-B')
  assert.equal(canonicalCameraName('CAM_C'), 'CAM-C')
  assert.equal(canonicalCameraName('camera d'), 'CAM-D')
  assert.equal(canonicalCameraName('Camera-A'), 'CAM-A')
  assert.equal(canonicalCameraName('cam.b'), 'CAM-B')
  assert.equal(canonicalCameraName('CAM A'), 'CAM-A')
  assert.equal(canonicalCameraName('  Cam A  '), 'CAM-A') // trimmed
  assert.equal(canonicalCameraName('cam e'), 'CAM-E')     // beyond D still normalizes
})

test('specials → UPPERCASE', () => {
  assert.equal(canonicalCameraName('audio'), 'AUDIO')
  assert.equal(canonicalCameraName('Audio'), 'AUDIO')
  assert.equal(canonicalCameraName('drone'), 'DRONE')
  assert.equal(canonicalCameraName('Switcher'), 'SWITCHER')
  assert.equal(canonicalCameraName('photo'), 'PHOTO')
  assert.equal(canonicalCameraName('screen'), 'SCREEN')
})

test('already canonical → null (no rename)', () => {
  assert.equal(canonicalCameraName('CAM-A'), null)
  assert.equal(canonicalCameraName('CAM-D'), null)
  assert.equal(canonicalCameraName('AUDIO'), null)
  assert.equal(canonicalCameraName('DRONE'), null)
})

test('names with extra text / unrelated names → null (never touched)', () => {
  assert.equal(canonicalCameraName('Cam A ของพี่ต้น'), null)
  assert.equal(canonicalCameraName('CAM-A backup'), null)
  assert.equal(canonicalCameraName('Global Focus (NWS-GLF-260714-01)'), null)
  assert.equal(canonicalCameraName('EP01 · -'), null)
  assert.equal(canonicalCameraName('Sound'), null)      // upload label, not a folder rename target
  assert.equal(canonicalCameraName('camp'), null)        // 'cam' + extra letter is NOT a cam slot
  assert.equal(canonicalCameraName('campaign assets'), null)
  assert.equal(canonicalCameraName('Photos 2026'), null)
  assert.equal(canonicalCameraName(''), null)
})
