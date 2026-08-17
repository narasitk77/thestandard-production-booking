// v1.175 — the Week Plan text export. This output is pasted into a chat window,
// so the tests pin the things that make it readable there: what a blank looks
// like, which days appear, and that a multi-line note does not explode the layout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWeekPlanText, countFilled, type ExportDay } from '../week-plan-export'

const day = (label: string, rows: any[]): ExportDay => ({ label, rows })
const row = (o: Partial<any> = {}) => ({
  time: '08:00 → 11:00', title: 'WLT · New Gen Investor', cameraCount: 3,
  equipment: 'FX6 3', rental: null, ...o,
})

test('a filled shoot renders time, title, cameras and both fields', () => {
  const t = buildWeekPlanText({ weekLabel: '17 – 23 Aug 2026', days: [day('อ. 18 Aug', [row()])] })
  assert.match(t, /📅 Week Plan · อุปกรณ์ \/ เช่า/)
  assert.match(t, /17 – 23 Aug 2026/)
  assert.match(t, /━━ อ\. 18 Aug · 1 งาน · ใส่แล้ว 1\/1/)
  assert.match(t, /• 08:00 → 11:00 {2}WLT · New Gen Investor {2}🎥3/)
  assert.match(t, /อุปกรณ์: FX6 3/)
  assert.match(t, /เช่า: —/)
})

test('an empty field prints "—" rather than vanishing', () => {
  // A missing line reads as "nothing needed"; the dash is what tells the operator
  // nobody has filled it in yet — which is the whole point of the page.
  const t = buildWeekPlanText({ weekLabel: 'w', days: [day('จ. 17 Aug', [row({ equipment: '  ', rental: null })])] })
  assert.match(t, /อุปกรณ์: —/)
  assert.match(t, /เช่า: —/)
  assert.match(t, /ใส่แล้ว 0\/1/)
})

test('a multi-line note collapses onto one line', () => {
  const t = buildWeekPlanText({ weekLabel: 'w', days: [day('จ.', [row({ equipment: 'FX3 2\nขาตั้ง 2\n\nไฟ 2 ดวง' })])] })
  assert.match(t, /อุปกรณ์: FX3 2 \/ ขาตั้ง 2 \/ ไฟ 2 ดวง/)
  assert.ok(!/\n\s{4}ขาตั้ง/.test(t), 'the note must not break the bullet layout')
})

test('days with no shoots are skipped — an empty heading is noise in a chat', () => {
  const t = buildWeekPlanText({ weekLabel: 'w', days: [day('จ.', []), day('อ.', [row()]), day('พ.', [])] })
  assert.ok(!t.includes('━━ จ.'))
  assert.ok(!t.includes('━━ พ.'))
  assert.match(t, /━━ อ\./)
})

test('filledOnly keeps the day counts honest — it hides rows, not the total', () => {
  const rows = [row(), row({ title: 'B', equipment: null, rental: null })]
  const t = buildWeekPlanText({ weekLabel: 'w', days: [day('อ.', rows)], filledOnly: true })
  assert.match(t, /ใส่แล้ว 1\/2/, 'the header still reports 2 shoots on the day')
  assert.ok(!t.includes('• 08:00 → 11:00  B'), 'the unfilled shoot is not listed')
})

test('an empty week says so instead of returning a bare header', () => {
  assert.match(buildWeekPlanText({ weekLabel: 'w', days: [] }), /\(ไม่มีงานในสัปดาห์นี้\)/)
  assert.match(
    buildWeekPlanText({ weekLabel: 'w', days: [day('อ.', [row({ equipment: null })])], filledOnly: true }),
    /\(ยังไม่มีงานที่กรอกอุปกรณ์\/เช่า\)/,
  )
})

test('no run of blank lines, and exactly one trailing newline', () => {
  const t = buildWeekPlanText({ weekLabel: 'w', days: [day('จ.', [row()]), day('อ.', [row()])] })
  assert.ok(!/\n{3}/.test(t), 'chat clients turn a run of blanks into a gap')
  assert.ok(t.endsWith('\n') && !t.endsWith('\n\n'))
})

test('countFilled counts a shoot with EITHER field, not both', () => {
  assert.equal(countFilled([row({ equipment: 'x', rental: null })]), 1)
  assert.equal(countFilled([row({ equipment: null, rental: 'y' })]), 1)
  assert.equal(countFilled([row({ equipment: ' ', rental: '' })]), 0)
})
