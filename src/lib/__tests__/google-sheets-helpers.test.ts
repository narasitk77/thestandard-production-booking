// v1.160 (PR #17) — Episode Titles cell (col AH) join semantics.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinEpisodeTitles } from '../google-sheets'

test('joins titles ordered by sequence with the " | " separator', () => {
  assert.equal(
    joinEpisodeTitles([
      { title: 'ตอนสอง', sequence: 2 },
      { title: 'ตอนแรก', sequence: 1 },
    ]),
    'ตอนแรก | ตอนสอง',
  )
})

test('blank/missing titles are dropped; missing sequence sorts first; empty list → empty cell', () => {
  assert.equal(joinEpisodeTitles([{ title: '  ' }, { title: null }, { title: 'จริง', sequence: 5 }]), 'จริง')
  assert.equal(joinEpisodeTitles([]), '')
})

test('does not mutate the caller array (create path reuses booking.episodes afterwards)', () => {
  const eps = [{ title: 'B', sequence: 2 }, { title: 'A', sequence: 1 }]
  joinEpisodeTitles(eps)
  assert.equal(eps[0].title, 'B')
})

// Previous IDs (col AS) — the "umbilical cord" PMDC needs to follow an in-place
// Production ID rewrite (regenerate / move-outlet). Case 2026-08-06:
// PM-PMG-260817-01 → NWS-TWD-260817-01.
import { appendPreviousId } from '../google-sheets'

test('first rewrite records the replaced code', () => {
  assert.equal(appendPreviousId('', 'PM-PMG-260817-01', 'NWS-TWD-260817-01'), 'PM-PMG-260817-01')
})

test('repeated moves keep the whole chain oldest-first without duplicates', () => {
  assert.equal(
    appendPreviousId('PM-PMG-260817-01', 'NWS-TWD-260817-01', 'NWS-TWD-260818-01'),
    'PM-PMG-260817-01, NWS-TWD-260817-01',
  )
  assert.equal(appendPreviousId('A-1, B-2', 'B-2', 'C-3'), 'A-1, B-2')
})

test('moving back to an older code does not list the current code as previous', () => {
  assert.equal(appendPreviousId('A-1, B-2', 'C-3', 'A-1'), 'B-2, C-3')
})

test('blank/garbage cells and a no-op rewrite are safe', () => {
  assert.equal(appendPreviousId(null, 'A-1', 'B-2'), 'A-1')
  assert.equal(appendPreviousId(' , ,A-1 ,', 'B-2', 'C-3'), 'A-1, B-2')
  assert.equal(appendPreviousId('A-1', 'B-2', 'B-2'), 'A-1')
})
