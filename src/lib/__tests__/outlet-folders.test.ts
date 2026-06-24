import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
  buildEpisodeFolderName,
  buildStoragePath,
  shootFolderLayers,
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

test('buildEpisodeFolderName: "EPnn · title" (1-based, zero-padded), bare "EPnn" without a title', () => {
  assert.equal(buildEpisodeFolderName({ sequence: 1, title: 'ตอนแรก' }), `EP01 ${DOT} ตอนแรก`)
  assert.equal(buildEpisodeFolderName({ sequence: 12, title: 'Finale' }), `EP12 ${DOT} Finale`)
  assert.equal(buildEpisodeFolderName({ sequence: 2, title: '' }), 'EP02') // no title → just the EP number
  assert.equal(buildEpisodeFolderName({ sequence: 3, title: null }), 'EP03')
  // path separators in a title can't break out of the single folder segment
  assert.ok(!buildEpisodeFolderName({ sequence: 1, title: 'a/b\\c' }).includes('/'))
})

test('buildEpisodeFolderName: useEpisodeId leads with the project EP ID (Content Agency)', () => {
  // AGN: lead with the unique project EP ID instead of EP01 (collision-safe
  // across bookings of the same project)
  assert.equal(
    buildEpisodeFolderName({ sequence: 1, title: 'ตอนA', episodeId: 'PP-26-008-L04' }, { useEpisodeId: true }),
    `PP-26-008-L04 ${DOT} ตอนA`,
  )
  // useEpisodeId but no episodeId → falls back to the running number
  assert.equal(buildEpisodeFolderName({ sequence: 2, title: 'X', episodeId: null }, { useEpisodeId: true }), `EP02 ${DOT} X`)
  // default (others) ignores episodeId
  assert.equal(buildEpisodeFolderName({ sequence: 3, title: 'Y', episodeId: 'PP-26-008-L09' }), `EP03 ${DOT} Y`)
})

test('shootFolderLayers: AGN groups by Project (no per-booking folder); others use show + Production ID', () => {
  // Content Agency → "<Project ID · name>" as the program box, and NO booking folder
  const agn = shootFolderLayers({
    outletCode: 'AGN', showName: 'ignored', category: 'ADVERTORIAL',
    projectId: 'PP-26-008', projectName: 'พีพี โปรเจค', bookingCode: 'AGN-260529-STD-01', jobName: 'job',
  })
  assert.equal(agn.programFolderName, `PP-26-008 ${DOT} พีพี โปรเจค`)
  assert.equal(agn.bookingFolderName, '') // '' = skip the per-booking layer
  // Other outlets → show name + "<Production ID · job>"
  const nws = shootFolderLayers({
    outletCode: 'NWS', showName: 'Key Message', category: null,
    projectId: null, projectName: null, bookingCode: 'NWS-KYM-260616-L-01', jobName: 'Morning',
  })
  assert.equal(nws.programFolderName, 'Key Message')
  assert.equal(nws.bookingFolderName, `NWS-KYM-260616-L-01 ${DOT} Morning`)
  // AGN with no projectId (shouldn't happen) → falls back to the normal layout
  const agnNoProj = shootFolderLayers({
    outletCode: 'AGN', showName: '', category: 'ADVERTORIAL',
    projectId: null, projectName: null, bookingCode: 'AGN-260529-STD-01', jobName: null,
  })
  assert.equal(agnNoProj.programFolderName, 'Advertorial')
  assert.equal(agnNoProj.bookingFolderName, 'AGN-260529-STD-01')
})

test('buildStoragePath: EP segment is inserted between bookingCode and camera (Wasabi collision guard)', () => {
  // no episode → flat key (unchanged)
  assert.deepEqual(
    buildStoragePath('AGN', 'AGN-260423-EVT-01', 'CAM-A', '001.mp4'),
    ['ADVERTORIAL', 'AGN-260423-EVT-01', 'CAM-A', '001.mp4'],
  )
  // EP-tagged → key carries the EP so same camera+filename across EPs differ
  assert.deepEqual(
    buildStoragePath('AGN', 'AGN-260423-EVT-01', 'CAM-A', '001.mp4', 'EP02'),
    ['ADVERTORIAL', 'AGN-260423-EVT-01', 'EP02', 'CAM-A', '001.mp4'],
  )
  // the whole point: identical camera+filename in different EPs → different keys
  const ep1 = buildStoragePath('AGN', 'X-01', 'CAM-A', 'clip.mp4', 'EP01').join('/')
  const ep2 = buildStoragePath('AGN', 'X-01', 'CAM-A', 'clip.mp4', 'EP02').join('/')
  assert.notEqual(ep1, ep2)
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
