/**
 * Booking-eligibility rule tests (run: npm test).
 *
 * The product rule under test: ONLY a "Published" episode is excluded
 * from booking. Everything else — Pending, Pre-production, Production,
 * Post-production, blank, or any status invented later — stays bookable.
 * These tests also pin the sheet-integration behaviors that broke twice
 * in June 2026: per-tab header-based column resolution and reading the
 * per-producer "PD <name>" tabs instead of the dead "_EPs" sync.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEpsColumns,
  selectEpisodeTabs,
  parseEpisodeTabs,
  bookableEpisodesFor,
  isPublishedStatus,
  bucketEpisodeStatus,
} from '../dashboard-episodes'

// ---------------------------------------------------------------------------
// isPublishedStatus — the single source of the booking rule
// ---------------------------------------------------------------------------

test('only Published (any casing / padding) is excluded from booking', () => {
  assert.equal(isPublishedStatus('Published'), true)
  assert.equal(isPublishedStatus('published'), true)
  assert.equal(isPublishedStatus('PUBLISHED'), true)
  assert.equal(isPublishedStatus('  Published  '), true)
})

test('every non-Published status stays bookable', () => {
  for (const s of [
    'Pending',
    'Pre-production',
    'Production',
    'Post-production',
    '',
    '   ',
    'On Hold',          // a status that doesn't exist yet — must stay bookable
    'Re-Published',     // contains the word but is not exactly "published"
    'Unpublished',
    null,
    undefined,
  ]) {
    assert.equal(isPublishedStatus(s as string), false, `status ${JSON.stringify(s)} must be bookable`)
  }
})

// ---------------------------------------------------------------------------
// bucketEpisodeStatus — Sheet Monitor stats: every status lands in ONE bucket
// ---------------------------------------------------------------------------

test('bucketEpisodeStatus: known statuses map to their buckets', () => {
  assert.equal(bucketEpisodeStatus('Pre-production'), 'preProduction')
  assert.equal(bucketEpisodeStatus('Production'), 'production')
  assert.equal(bucketEpisodeStatus('Post-production'), 'postProduction')
  assert.equal(bucketEpisodeStatus('Published'), 'published')
  assert.equal(bucketEpisodeStatus('Pending'), 'pending')
})

test('bucketEpisodeStatus: unknown/blank statuses land in "other", never vanish', () => {
  assert.equal(bucketEpisodeStatus(''), 'other')
  assert.equal(bucketEpisodeStatus('   '), 'other')
  assert.equal(bucketEpisodeStatus('On Hold'), 'other')
  assert.equal(bucketEpisodeStatus(null), 'other')
  assert.equal(bucketEpisodeStatus(undefined), 'other')
})

test('bucketEpisodeStatus agrees with the booking rule: only the published bucket is unbookable', () => {
  for (const s of ['Pending', 'Pre-production', 'Production', 'Post-production', '', 'อะไรก็ได้']) {
    assert.notEqual(bucketEpisodeStatus(s), 'published')
    assert.equal(isPublishedStatus(s), false)
  }
  assert.equal(bucketEpisodeStatus(' PUBLISHED '), 'published')
  assert.equal(isPublishedStatus(' PUBLISHED '), true)
})

// ---------------------------------------------------------------------------
// resolveEpsColumns — header-based column resolution (both real layouts)
// ---------------------------------------------------------------------------

const PD_HEADER = [
  'Project ID', 'Episode Type', 'Episode ID', 'Project Name', 'Director',
  'Product Code', 'EP.', 'Status', 'Cost Sheet', 'Timeline / Breakdown',
  'Footage Folder', 'Publish Link', 'Note', 'Storyline / PPM',
  'Shooting Script', 'Rough Cut', 'Final Video', 'Director Note',
]

const LEGACY_EPS_HEADER = [
  'EP_ID', 'Project Name', 'Product Code', 'EP.', 'Status', 'Cost Sheet',
  'Timeline / Breakdown', 'Footage Folder', 'Publish Link',
  'Storytelling Canvas', 'Shooting Script', 'Rough Cut', 'Final Video',
  'Episode ID', 'Airtable Deliverable ID', 'Note', 'Producer', 'Director',
]

test('resolveEpsColumns: PD tab layout (Episode ID col C, Status col H)', () => {
  const cols = resolveEpsColumns(PD_HEADER)
  assert.equal(cols.episodeId, 2)
  assert.equal(cols.status, 7)
  assert.equal(cols.ep, 6)
  assert.equal(cols.productCode, 5)
  assert.equal(cols.projectName, 3)
})

test('resolveEpsColumns: legacy _EPs layout (Episode ID col N, Status col E) — EP_ID must not match', () => {
  const cols = resolveEpsColumns(LEGACY_EPS_HEADER)
  assert.equal(cols.episodeId, 13)
  assert.equal(cols.status, 4)
  assert.equal(cols.ep, 3)
  assert.equal(cols.productCode, 2)
  assert.equal(cols.projectName, 1)
})

test('resolveEpsColumns: a future reshuffle is followed by header names', () => {
  const cols = resolveEpsColumns(['Status', 'Episode ID', 'EP.', 'Project Name', 'Product Code'])
  assert.equal(cols.episodeId, 1)
  assert.equal(cols.status, 0)
})

test('resolveEpsColumns: missing header falls back to the PD layout', () => {
  const cols = resolveEpsColumns(undefined)
  assert.equal(cols.episodeId, 2)
  assert.equal(cols.status, 7)
})

// ---------------------------------------------------------------------------
// selectEpisodeTabs — tab discovery
// ---------------------------------------------------------------------------

test('selectEpisodeTabs: picks every "PD <name>" tab + legacy _EPs, ignores the rest', () => {
  const tabs = selectEpisodeTabs([
    '_Link Gap Report', 'All Projects', 'PD อ้อม', '_Update Log', 'PD ไนซ์',
    'PD ซัง', 'Dir. ป้าย', 'Dir. ท็อป', '_Users', '_EPs',
    '_EPs Backup 20260511-1202', 'Bookings',
  ])
  assert.deepEqual(tabs, ['PD อ้อม', 'PD ไนซ์', 'PD ซัง', '_EPs'])
})

test('selectEpisodeTabs: a NEW producer tab is picked up automatically', () => {
  const tabs = selectEpisodeTabs(['All Projects', 'PD ไนซ์', 'PD น้องใหม่', '_EPs'])
  assert.deepEqual(tabs, ['PD ไนซ์', 'PD น้องใหม่', '_EPs'])
})

test('selectEpisodeTabs: works even if _EPs is deleted some day', () => {
  const tabs = selectEpisodeTabs(['All Projects', 'PD ไนซ์'])
  assert.deepEqual(tabs, ['PD ไนซ์'])
})

// ---------------------------------------------------------------------------
// parseEpisodeTabs — mixed layouts, dedupe, junk rows
// ---------------------------------------------------------------------------

function pdRow(episodeId: string, status: string, ep = '-', name = 'Proj', code = 'QU-1') {
  // PD layout: A ProjectID · B Type · C Episode ID · D Name · E Director · F Code · G EP. · H Status
  const projectId = episodeId.slice(0, 9)
  return [projectId, 'S', episodeId, name, 'ใครสักคน', code, ep, status]
}

function legacyRow(episodeId: string, status: string) {
  // _EPs layout: ...D EP. · E Status · ... · N Episode ID
  const r = new Array(18).fill('')
  r[1] = 'Legacy Proj'; r[2] = 'QU-OLD'; r[3] = '-'; r[4] = status; r[13] = episodeId
  return r
}

test('parseEpisodeTabs: reads PD layout and legacy _EPs layout in the same pass', () => {
  const eps = parseEpisodeTabs([
    [PD_HEADER, pdRow('PP-26-025-S01', 'Pre-production')],
    [LEGACY_EPS_HEADER, legacyRow('PP-26-013-L01', 'Pre-production')],
  ])
  assert.deepEqual(eps.map(e => e.episodeId).sort(), ['PP-26-013-L01', 'PP-26-025-S01'])
})

test('parseEpisodeTabs: on duplicate Episode ID the earlier (PD) tab wins', () => {
  const eps = parseEpisodeTabs([
    [PD_HEADER, pdRow('PP-26-016-S01', 'Production')],          // fresh, from PD tab
    [LEGACY_EPS_HEADER, legacyRow('PP-26-016-S01', 'Pre-production')], // stale _EPs copy
  ])
  assert.equal(eps.length, 1)
  assert.equal(eps[0].status, 'Production')
})

test('parseEpisodeTabs: banner/junk/malformed rows are ignored', () => {
  const eps = parseEpisodeTabs([
    [
      PD_HEADER,
      ['', '', 'คลิกที่ dropdown เพื่อเลือก', '', '', '', '', ''],
      ['PP-26-025', 'S', 'NOT-AN-ID', 'Proj', '', '', '-', 'Pending'],
      [],
      pdRow('PP-26-025-S02', 'Pending'),
    ],
  ])
  assert.deepEqual(eps.map(e => e.episodeId), ['PP-26-025-S02'])
})

test('parseEpisodeTabs: episode type parsed from the ID suffix', () => {
  const eps = parseEpisodeTabs([[PD_HEADER, pdRow('PP-26-025-L01', 'Pending')]])
  assert.equal(eps[0].type, 'L')
})

// ---------------------------------------------------------------------------
// bookableEpisodesFor — the end-to-end filter the booking form sees
// ---------------------------------------------------------------------------

test('bookableEpisodesFor: everything except Published shows up, for the right project only', () => {
  const all = parseEpisodeTabs([[
    PD_HEADER,
    pdRow('PP-26-025-S01', 'Pre-production'),
    pdRow('PP-26-025-S02', 'Production'),
    pdRow('PP-26-025-S03', 'Post-production'),
    pdRow('PP-26-025-S04', 'Pending'),
    pdRow('PP-26-025-S05', ''),               // blank status — still bookable
    pdRow('PP-26-025-S06', 'สถานะใหม่ในอนาคต'), // unknown future status — still bookable
    pdRow('PP-26-025-S07', 'Published'),       // the ONLY exclusion
    pdRow('PP-26-025-S08', ' published '),     // sloppy casing/padding still excluded
    pdRow('PP-26-099-S01', 'Pending'),         // another project — not in this list
  ]])
  const bookable = bookableEpisodesFor(all, 'PP-26-025')
  assert.deepEqual(
    bookable.map(e => e.episodeId).sort(),
    ['PP-26-025-S01', 'PP-26-025-S02', 'PP-26-025-S03', 'PP-26-025-S04', 'PP-26-025-S05', 'PP-26-025-S06'],
  )
})

test('bookableEpisodesFor: project with ONLY Published episodes offers nothing', () => {
  const all = parseEpisodeTabs([[PD_HEADER, pdRow('PP-26-003-S01', 'Published')]])
  assert.deepEqual(bookableEpisodesFor(all, 'PP-26-003'), [])
})
