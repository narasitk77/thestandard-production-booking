import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
  camerasToPreCreate,
  cameraUploadOptions,
} from '../outlet-folders'

const DOT = '·' // U+00B7 MIDDLE DOT — the exact separator PMC's Drive uses

test('outletDriveFolderName: "NN · Name" from the OUTLETS master (sort-based)', () => {
  assert.equal(outletDriveFolderName('NWS'), `01 ${DOT} News`)
  assert.equal(outletDriveFolderName('TSS'), `08 ${DOT} The Secret Sauce`)
  assert.equal(outletDriveFolderName('AGN'), `09 ${DOT} Content Agency`)
  assert.equal(outletDriveFolderName('agn'), `09 ${DOT} Content Agency`) // case-insensitive
  assert.equal(outletDriveFolderName('ZZZ'), 'ZZZ') // unknown → bare code fallback
})

test('programFolderName: AGN keys off category, outlets use the show name', () => {
  assert.equal(programFolderName({ outletCode: 'AGN', category: 'ADVERTORIAL' }), 'Advertorial')
  assert.equal(programFolderName({ outletCode: 'AGN', category: 'EVENT' }), 'Event / Forum')
  // AGN with an off-list category falls back to the show name, then 'Advertorial'
  assert.equal(programFolderName({ outletCode: 'AGN', category: 'INTERNAL', showName: '' }), 'Advertorial')
  // outlet shows → real show name, no code
  assert.equal(programFolderName({ outletCode: 'NWS', showName: 'Key Message' }), 'Key Message')
  assert.equal(programFolderName({ outletCode: 'NWS', showName: '' }), 'รายการ')
})

test('buildBookingFolderName uses the U+00B7 middle-dot separator', () => {
  assert.equal(buildBookingFolderName('TSS-EXE-260826-L-01', 'งานทดสอบ'), `TSS-EXE-260826-L-01 ${DOT} งานทดสอบ`)
  assert.equal(buildBookingFolderName('TSS-EXE-260826-L-01', null), 'TSS-EXE-260826-L-01') // no job → bare code
  // explicitly NOT a hyphen
  assert.ok(!buildBookingFolderName('X-01', 'job').includes(' - '))
})

test('camerasToPreCreate: CAM-A..CAM-{n} (cap D) + AUDIO if mics; empty for block shot', () => {
  assert.deepEqual(camerasToPreCreate(2, 1), ['CAM-A', 'CAM-B', 'AUDIO'])
  assert.deepEqual(camerasToPreCreate(3, 0), ['CAM-A', 'CAM-B', 'CAM-C'])
  assert.deepEqual(camerasToPreCreate(9, 2), ['CAM-A', 'CAM-B', 'CAM-C', 'CAM-D', 'AUDIO']) // capped at D
  assert.deepEqual(camerasToPreCreate(null, null), []) // Block Shot / unspecified → none pre-created
})

test('cameraUploadOptions: never empty (min CAM-A) + always the specials', () => {
  assert.deepEqual(cameraUploadOptions(0, 0), ['CAM-A', 'DRONE', 'SWITCHER', 'PHOTO', 'SCREEN'])
  assert.deepEqual(cameraUploadOptions(2, 1), ['CAM-A', 'CAM-B', 'AUDIO', 'DRONE', 'SWITCHER', 'PHOTO', 'SCREEN'])
})
