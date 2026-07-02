import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
  legacyBookingFolderName,
  cleanJobName,
  folderNameMatchesCode,
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

test('buildBookingFolderName: v1.110 show-first "<show> · <job> (<code>)"', () => {
  assert.equal(
    buildBookingFolderName('WLT-EXI-260701-01', 'โบนัสสุกี้', 'Exclusive Interview'),
    `Exclusive Interview ${DOT} โบนัสสุกี้ (WLT-EXI-260701-01)`,
  )
  // job == show (no distinct job) → "<show> (<code>)"
  assert.equal(
    buildBookingFolderName('WLT-EXI-260701-01', 'Exclusive Interview', 'Exclusive Interview'),
    'Exclusive Interview (WLT-EXI-260701-01)',
  )
  // no show passed → "<job> (<code>)"
  assert.equal(buildBookingFolderName('TSS-EXE-260826-01', 'งานทดสอบ'), 'งานทดสอบ (TSS-EXE-260826-01)')
  // strips the van/logistics parenthetical out of the job
  assert.equal(
    buildBookingFolderName('TSS-TSS-260701-01', 'วิน Souri (รถ. 1. ก.ค ทัด. 081-8018202 ฮย-3959)', 'The Secret Sauce'),
    `The Secret Sauce ${DOT} วิน Souri (TSS-TSS-260701-01)`,
  )
  // neither show nor job → bare code
  assert.equal(buildBookingFolderName('X-01', null), 'X-01')
  assert.ok(!buildBookingFolderName('X-01', 'job').includes(' - '))
})

test('cleanJobName strips ONLY a trailing logistics parenthetical', () => {
  assert.equal(cleanJobName('วิน Souri (รถ. 1. ก.ค ทัด. 081-8018202 ฮย-3959)'), 'วิน Souri')
  assert.equal(cleanJobName('งาน (โทร. 0812345678)'), 'งาน')
  assert.equal(cleanJobName('โบนัสสุกี้'), 'โบนัสสุกี้')
  assert.equal(cleanJobName('EP.5 (พิเศษ)'), 'EP.5 (พิเศษ)') // no digits/keywords → kept
  assert.equal(cleanJobName(null), '')
})

// v1.111 — folder names must be SMB/NTFS-safe: the Production Team landing
// folders mirror to the office NAS, and a ":" in a job title made the folder
// silently fail to sync (existed on Drive, never appeared on the NAS).
test('folder names strip SMB-illegal characters (: * ? " < > |)', () => {
  assert.equal(
    buildBookingFolderName('TSS-260702-01', 'TSS: Interview Adver: กกพ. EP.2', 'Long-form'),
    `Long-form ${DOT} TSS Interview Adver กกพ. EP.2 (TSS-260702-01)`,
  )
  assert.equal(
    buildEpisodeFolderName({ sequence: 1, title: 'TSS: Interview Adver: BCG' }),
    `EP01 ${DOT} TSS Interview Adver BCG`,
  )
})

test('legacyBookingFolderName keeps the pre-v1.110 "<code> · <job>" shape', () => {
  assert.equal(legacyBookingFolderName('TSS-EXE-260826-L-01', 'งานทดสอบ'), `TSS-EXE-260826-L-01 ${DOT} งานทดสอบ`)
  assert.equal(legacyBookingFolderName('TSS-EXE-260826-L-01', null), 'TSS-EXE-260826-L-01')
})

test('folderNameMatchesCode matches legacy (code leads) AND v1.110 (code in parens)', () => {
  assert.equal(folderNameMatchesCode('TSS-260701-01 · job', 'TSS-260701-01'), true)          // legacy
  assert.equal(folderNameMatchesCode('The Secret Sauce · วิน (TSS-260701-01)', 'TSS-260701-01'), true) // v1.110
  assert.equal(folderNameMatchesCode('TSS-260701-01', 'TSS-260701-01'), true)                 // bare
  assert.equal(folderNameMatchesCode('OTHER-01 · x', 'TSS-260701-01'), false)
  assert.equal(folderNameMatchesCode('TSS-260701-011 · x', 'TSS-260701-01'), false)           // no prefix false-match
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

test('shootFolderLayers: AGN nests Project under the category box; others use show + Production ID', () => {
  // Content Agency Advertorial → category box "Advertorial" then "<Project ID · name>"
  const agnAd = shootFolderLayers({
    outletCode: 'AGN', showName: 'ignored', category: 'ADVERTORIAL',
    projectId: 'PP-26-008', projectName: 'พีพี โปรเจค', bookingCode: 'AGN-260529-STD-01', jobName: 'job',
  })
  assert.equal(agnAd.programFolderName, 'Advertorial')
  assert.equal(agnAd.bookingFolderName, `PP-26-008 ${DOT} พีพี โปรเจค`)
  // Content Agency Event → category box "Event / Forum" (matches PMC's pre-created folder)
  const agnEv = shootFolderLayers({
    outletCode: 'AGN', showName: 'ignored', category: 'EVENT',
    projectId: 'PP-26-020', projectName: 'อีเวนต์', bookingCode: 'AGN-260529-EVT-01', jobName: null,
  })
  assert.equal(agnEv.programFolderName, 'Event / Forum')
  assert.equal(agnEv.bookingFolderName, `PP-26-020 ${DOT} อีเวนต์`)
  // Other outlets → show name + "<Production ID · job>"
  const nws = shootFolderLayers({
    outletCode: 'NWS', showName: 'Key Message', category: null,
    projectId: null, projectName: null, bookingCode: 'NWS-KYM-260616-L-01', jobName: 'Morning',
  })
  assert.equal(nws.programFolderName, 'Key Message')
  assert.equal(nws.bookingFolderName, `Key Message ${DOT} Morning (NWS-KYM-260616-L-01)`) // v1.110 show-first
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
