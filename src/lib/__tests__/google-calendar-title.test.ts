/**
 * Calendar event title tests (run: npm test).
 *
 * Rule (ops feedback, June 2026): the event title leads with the SHOW the
 * crew is shooting — the booking's projectName for Content Agency project
 * bookings (e.g. "KEY MESSAGES x DMHT"), the program name for outlet
 * bookings — never the generic "(project)" program label.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEventTitle } from '../google-calendar'

const base = {
  shootType: 'STUDIO',
  videoType: null as string | null,
  cameraCount: null as number | null,
  micCount: null as number | null,
  needsVan: false,
}

test('Content Agency: title leads with the project name, then the first EP name', () => {
  const title = buildEventTitle({
    ...base,
    projectName: 'KEY MESSAGES x DMHT',
    outlet: { code: 'AGN', name: 'Content Agency' },
    program: { code: 'AGN-LF', name: 'Long Form (project)' },
    episodes: [{ episodeId: 'PP-26-010-L01', title: 'Pre EP.1 - BKK' }],
  })
  assert.equal(title, '[AGN] KEY MESSAGES x DMHT — Pre EP.1 - BKK')
})

test('Content Agency: EP segment dropped when it just repeats the project name (EP. = "-")', () => {
  const title = buildEventTitle({
    ...base,
    projectName: 'Bulgari x Wealth',
    outlet: { code: 'AGN', name: 'Content Agency' },
    program: { code: 'AGN-SC', name: 'Short Clip (project)' },
    episodes: [{ episodeId: 'PP-26-026-S01', title: 'Bulgari x Wealth' }],
  })
  assert.equal(title, '[AGN] Bulgari x Wealth')
})

test('Content Agency: multi-EP shows the show name + EP count', () => {
  const title = buildEventTitle({
    ...base,
    projectName: 'Awesome Skills Project',
    outlet: { code: 'AGN', name: 'Content Agency' },
    program: { code: 'AGN-ST', name: 'Spot / Teaser (project)' },
    episodes: [
      { episodeId: 'PP-26-025-S01', title: 'Pre EP.1 - BKK' },
      { episodeId: 'PP-26-025-S02', title: 'Post EP.1 - BKK' },
      { episodeId: 'PP-26-025-S15', title: 'Voxpop - BKK' },
    ],
  })
  assert.equal(title, '[AGN] Awesome Skills Project — 3 EPs')
})

test('Outlet booking (no project): program name leads, unchanged from before', () => {
  const title = buildEventTitle({
    ...base,
    projectName: null,
    outlet: { code: 'NWS', name: 'News' },
    program: { code: 'ENG', name: 'End Game' },
    episodes: [{ episodeId: 'NWS-260616-ENG-01', title: 'ศก.โลกครึ่งปีหลัง' }],
  })
  assert.equal(title, '[NWS] End Game — ศก.โลกครึ่งปีหลัง')
})

test('descriptor segments and van prefix still wrap the new core', () => {
  const title = buildEventTitle({
    ...base,
    needsVan: true,
    videoType: 'Teaser / Highlight',
    cameraCount: 2,
    micCount: 1,
    projectName: 'KEY MESSAGES x DMHT',
    outlet: { code: 'AGN', name: 'Content Agency' },
    program: { code: 'AGN-LF', name: 'Long Form (project)' },
    episodes: [{ episodeId: 'PP-26-010-L01', title: 'Pre EP.1 - BKK' }],
  })
  assert.equal(title, '🚐 [AGN] KEY MESSAGES x DMHT — Pre EP.1 - BKK · Teaser / Highlight · 🎥 2 · 🎙 1')
})

test('blank projectName falls back to the program name', () => {
  const title = buildEventTitle({
    ...base,
    projectName: '   ',
    outlet: { code: 'AGN', name: 'Content Agency' },
    program: { code: 'AGN-EVT', name: 'Event / Forum' },
    episodes: [{ episodeId: 'PP-26-030-S01', title: 'พิธีเปิดสำนักงานภาคใต้' }],
  })
  assert.equal(title, '[AGN] Event / Forum — พิธีเปิดสำนักงานภาคใต้')
})
