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
