/**
 * Unit tests for planEpisodesToLink (v1.95.0) — the pure decision logic behind
 * POST /api/admin/[id]/add-episodes. No Prisma / Sheets.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planEpisodesToLink, type ProjectEp } from '../link-episodes'

function projMap(eps: ProjectEp[]): Map<string, ProjectEp> {
  return new Map(eps.map(e => [e.episodeId, e]))
}

test('links new episodes, sequence continues after current max', () => {
  const proj = projMap([
    { episodeId: 'PP-26-025-L02', ep: 'Highlight', projectName: 'Awesome Skills' },
    { episodeId: 'PP-26-025-S16', ep: '-', projectName: 'Awesome Skills' },
  ])
  const { toAdd, skipped } = planEpisodesToLink(
    ['PP-26-025-L02', 'PP-26-025-S16'], proj, new Set(['PP-26-025-L01', 'PP-26-025-S15']), 2,
  )
  assert.equal(toAdd.length, 2)
  assert.deepEqual(toAdd.map(e => e.sequence), [3, 4])         // append after max=2
  assert.equal(toAdd[0].title, 'Highlight')                    // ep label used
  assert.equal(toAdd[1].title, 'Awesome Skills')               // ep '-' -> projectName fallback
  assert.deepEqual(skipped, { already: [], notInProject: [] })
})

test('skips episodes already on the booking', () => {
  const proj = projMap([{ episodeId: 'PP-26-025-L01', ep: 'Wrap-up', projectName: 'AS' }])
  const { toAdd, skipped } = planEpisodesToLink(['PP-26-025-L01'], proj, new Set(['PP-26-025-L01']), 1)
  assert.equal(toAdd.length, 0)
  assert.deepEqual(skipped.already, ['PP-26-025-L01'])
})

test('skips episodes not present in the project Sheet (never mints)', () => {
  const { toAdd, skipped } = planEpisodesToLink(['PP-26-025-X99'], projMap([]), new Set(), 0)
  assert.equal(toAdd.length, 0)
  assert.deepEqual(skipped.notInProject, ['PP-26-025-X99'])
})

test('dedupes duplicate requested ids and trims whitespace', () => {
  const proj = projMap([{ episodeId: 'PP-26-025-L02', ep: 'Highlight', projectName: 'AS' }])
  const { toAdd } = planEpisodesToLink(['PP-26-025-L02', ' PP-26-025-L02 ', ''], proj, new Set(), 5)
  assert.equal(toAdd.length, 1)
  assert.equal(toAdd[0].sequence, 6)
})
