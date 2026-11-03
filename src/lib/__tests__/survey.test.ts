// v1.278 — the survey's answer gate and its time-saved maths.
// The gate decides what lands in survey_responses; the maths is the number Nat reports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnswers, summarize, questionsFor, SURVEY, TEXT_MAX } from '../survey'

const BOOKER = { role: 'booker', b_now: '5_10', b_before: '30_60', b_chase: 'much_less', hours: '1_2', feel: '4' }
const QUEUE = { role: 'queue', q_now: '2_5', q_before: '15_30', q_chase: 'less', hours: '2_4', feel: '5' }

test('each group sees only its own section', () => {
  const b = questionsFor('booker').map(q => q.id)
  const q = questionsFor('queue').map(q => q.id)
  assert.ok(b.includes('b_now') && !b.includes('q_now'))
  assert.ok(q.includes('q_now') && !q.includes('b_now'))
  assert.equal(b.length, q.length)
})

test('a complete booker answer passes, and the other group is stripped', () => {
  const r = validateAnswers({ ...BOOKER, q_now: 'lt2', smuggled: 'x' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.group, 'booker')
  assert.equal(r.answers.q_now, undefined)
  assert.equal((r.answers as any).smuggled, undefined)
  assert.equal(r.answers.b_now, '5_10')
})

test('required questions and the role are enforced', () => {
  assert.equal(validateAnswers({ ...BOOKER, role: undefined }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, role: 'crew' }).ok, false)
  const { b_now, ...noNow } = BOOKER
  assert.equal(validateAnswers(noNow).ok, false)
  // a queue answer cannot be satisfied by booker fields
  assert.equal(validateAnswers({ ...BOOKER, role: 'queue' }).ok, false)
  assert.equal(validateAnswers(QUEUE).ok, true)
})

test('unknown options, wrong types and non-objects are refused', () => {
  assert.equal(validateAnswers({ ...BOOKER, b_now: 'forever' }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, b_now: ['5_10'] }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, faster: ['book', 'hack'] }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, faster: 'book' }).ok, false)
  assert.equal(validateAnswers(null).ok, false)
  assert.equal(validateAnswers([BOOKER]).ok, false)
})

test('multi choices: deduped, "none" is exclusive, other text kept and capped', () => {
  const r = validateAnswers({ ...BOOKER, faster: ['book', 'book', 'calendar'], faster_other: '  ลิงก์ Drive  ' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.answers.faster, ['book', 'calendar'])
    assert.equal(r.answers.faster_other, 'ลิงก์ Drive')
  }
  assert.equal(validateAnswers({ ...BOOKER, faster: ['none', 'book'] }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, faster: ['none'], faster_other: 'x' }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, slower: ['qu'], slower_other: 'x'.repeat(201) }).ok, false)
})

test('free text is trimmed, optional, and capped', () => {
  const r = validateAnswers({ ...BOOKER, wish: '  เลื่อนวันได้เลย  ', note: '' })
  assert.equal(r.ok, true)
  if (r.ok) { assert.equal(r.answers.wish, 'เลื่อนวันได้เลย'); assert.equal(r.answers.note, undefined) }
  assert.equal(validateAnswers({ ...BOOKER, note: 'x'.repeat(TEXT_MAX + 1) }).ok, false)
  assert.equal(validateAnswers({ ...BOOKER, note: 42 }).ok, false)
})

test('every option id is unique within its question', () => {
  for (const q of SURVEY.questions) {
    const ids = (q.options || []).map(o => o.id)
    assert.equal(new Set(ids).size, ids.length, q.id)
    if (q.exclusive) assert.ok(ids.includes(q.exclusive), q.id)
  }
})

test('summary: hours ignore "unsure", per-booking saving uses only people who knew the old way', () => {
  const s = summarize([
    { group: 'booker', answers: { ...BOOKER } },                                         // 45 → 7.5 min, 1.5 h/wk
    { group: 'booker', answers: { ...BOOKER, b_now: 'lt5', b_before: '1_2h', hours: 'unsure', feel: '2' } }, // 90 → 3
    { group: 'booker', answers: { ...BOOKER, b_before: 'na', hours: 'worse', wish: 'อยากเลื่อนวันได้' } },   // not in per-booking
    { group: 'queue', answers: { ...QUEUE, slower: ['qu'], slower_other: 'ห้อง' } },
    { group: 'crew', answers: { ...BOOKER } },                                           // unknown group → ignored
  ])
  assert.equal(s.total, 4)
  assert.deepEqual(s.byGroup, { booker: 3, queue: 1 })
  assert.equal(s.hoursPerWeek.n, 3)                                   // 1.5, -0.5, 3
  assert.ok(Math.abs((s.hoursPerWeek.avg ?? 0) - (1.5 - 0.5 + 3) / 3) < 1e-9)
  assert.equal(s.perItem.booker.n, 2)
  assert.equal(s.perItem.booker.before, (45 + 90) / 2)
  assert.equal(s.perItem.booker.now, (7.5 + 3) / 2)
  assert.equal(s.perItem.booker.saved, (45 + 90) / 2 - (7.5 + 3) / 2)
  assert.equal(s.perItem.queue.saved, 22.5 - 3.5)
  assert.equal(s.counts.b_chase.much_less, 3)
  assert.equal(s.feel.n, 4)
  assert.equal(s.feel.positivePct, 75)
  assert.deepEqual(s.texts.wish, ['อยากเลื่อนวันได้'])
  assert.deepEqual(s.texts.other, ['ห้อง'])
})
