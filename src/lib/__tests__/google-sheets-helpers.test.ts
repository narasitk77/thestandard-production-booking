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

// Backfill pass 4 — AJ–AR were written only on create/edit since v1.203, so rows created
// before it kept them blank (Agency Ref empty on 97 rows with a QU in the DB). The plan is
// fill-blank only, formatted like the live write paths, with positions from COL.
import { planFillBlankCells, bookingsColLetter, FILL_BLANK_LAST_COL } from '../google-sheets'

const fullBooking = {
  deliveredAt: null, deliveredBy: null, cancelReason: null, episodes: [], driveFolders: null,
  equipmentNote: 'Sony FX6 x2', rentalGearNote: null, cameraCount: 2, micCount: 0, vanCount: null,
  specialEquipment: ['Gimbal', 'Slider'], agencyRef: 'QU-4480', isBlockShot: true, itinerary: 'BKK → CNX',
}

test('gear cells AJ–AR: blank cells get the DB value; null stays blank, 0 is a real answer', () => {
  const row = Array(45).fill('')
  row[0] = 'AGN-260713-01'
  assert.deepEqual(planFillBlankCells(fullBooking, row), {
    equipmentNote: 'Sony FX6 x2', cameraCount: '2', micCount: '0',
    specialEquipment: 'Gimbal, Slider', agencyRef: 'QU-4480', blockShot: 'Yes', itinerary: 'BKK → CNX',
  })
})

test('a cell that already holds a value is never overwritten; a short row (trailing blanks trimmed) counts as blank', () => {
  const row = Array(45).fill('')
  row[41] = 'QU-4480 (hand-fixed)' // col AP
  row[37] = '3'                    // col AL
  const plan = planFillBlankCells(fullBooking, row)
  assert.equal('agencyRef' in plan, false)
  assert.equal('cameraCount' in plan, false)
  // values.get drops trailing empty cells: a row read as col A only
  assert.equal(planFillBlankCells(fullBooking, ['AGN-260713-01']).agencyRef, 'QU-4480')
})

test('columns come from COL: Agency Ref = AP, Camera Count = AL, H/I/K for call/wrap/location, read range ends at AR', () => {
  assert.equal(bookingsColLetter('agencyRef'), 'AP')
  assert.equal(bookingsColLetter('cameraCount'), 'AL')
  assert.equal(bookingsColLetter('deliveredAt'), 'AE')
  assert.equal(bookingsColLetter('callTime'), 'H')
  assert.equal(bookingsColLetter('wrapTime'), 'I')
  assert.equal(bookingsColLetter('location'), 'K')
  assert.equal(FILL_BLANK_LAST_COL, 'AR')
})

test('AE–AI keep their old fill-blank behaviour (delivery evidence, titles, box id)', () => {
  const b = {
    ...fullBooking, equipmentNote: null, cameraCount: null, micCount: null, specialEquipment: [], agencyRef: null, isBlockShot: false, itinerary: null,
    deliveredBy: 'crew@x.co', cancelReason: 'ลูกค้าเลื่อน',
    episodes: [{ title: 'สอง', sequence: 2 }, { title: 'หนึ่ง', sequence: 1 }],
  }
  assert.deepEqual(planFillBlankCells(b, []), { deliveredBy: 'crew@x.co', cancelReason: 'ลูกค้าเลื่อน', episodeTitles: 'หนึ่ง | สอง' })
})
