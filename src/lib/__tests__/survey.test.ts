// v1.279 — the survey's answer gate and its summary.
// The gate decides what lands in survey_responses; the summary is what the admin page shows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnswers, summarize, applyOverrides, validateOverrides, SURVEY, TEAMS, TEAM_MIN, TEXT_MAX, OTHER_MAX, type SurveyDef } from '../survey'

// v1.284.2 — `keep` / `change` (Q4 / Q5) are required typed answers, so the base answer carries one of each
const BASE = { team: 'nws', efficiency: '4', satisfaction: '3', keep: 'ดูสถานะคิวได้เอง', change: 'ฟอร์มจองยาวไป' }

// SURVEY has no multi-choice question any more (Q4/Q5 are typed text), but the multi branch of the gate, the summary and the
// wording overrides is still real code — it keeps its tests against this test-only survey (SURVEY + one multi-choice question).
const TEST: SurveyDef = { ...SURVEY, questions: [...SURVEY.questions, {
  id: 'useful', kind: 'multi', required: false, exclusive: 'none', title: 'ส่วนไหนที่ดี', help: 'เลือกได้หลายข้อ',
  options: [{ id: 'status', label: 'หน้า My Bookings' }, { id: 'calendar', label: 'หน้า Calendar' }, { id: 'none', label: 'ไม่มีข้อไหนเลย' }],
}] }
const vaT = (raw: unknown) => validateAnswers(raw, TEST)
const vo = (raw: unknown) => validateOverrides(raw, TEST)
const ao = (ov: Parameters<typeof applyOverrides>[0]) => applyOverrides(ov, TEST)

test('a complete answer passes; team goes to group, unknown keys are stripped', () => {
  const r = validateAnswers({ ...BASE, smuggled: 'x', role: 'queue' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.group, 'nws')
  assert.deepEqual(r.answers, { efficiency: '4', satisfaction: '3', keep: 'ดูสถานะคิวได้เอง', change: 'ฟอร์มจองยาวไป' })
})

test('team, both scales, keep and change are required; the open question may be left out', () => {
  for (const k of ['team', 'efficiency', 'satisfaction', 'keep', 'change'] as const) {
    const { [k]: _gone, ...rest } = BASE
    assert.equal(validateAnswers(rest).ok, false, k)
  }
  assert.equal(validateAnswers({ ...BASE, keep: '   ' }).ok, false)     // whitespace is not an answer
  assert.equal(validateAnswers({ ...BASE, change: '' }).ok, false)
  assert.equal(validateAnswers({ ...BASE, improve: '' }).ok, true)
})

test('v1.284.2 — keep / change are typed text: trimmed, capped, strings only, stored under their own ids', () => {
  const r = validateAnswers({ ...BASE, keep: '  อีเมลอนุมัติ  ', change: '\nฟอร์มสั้นลง ' })
  assert.equal(r.ok, true)
  if (r.ok) { assert.equal(r.answers.keep, 'อีเมลอนุมัติ'); assert.equal(r.answers.change, 'ฟอร์มสั้นลง') }
  assert.equal(validateAnswers({ ...BASE, keep: 'x'.repeat(TEXT_MAX + 1) }).ok, false)
  assert.equal(validateAnswers({ ...BASE, change: ['form'] }).ok, false)   // the old multi-choice shape no longer fits
  assert.equal(validateAnswers({ ...BASE, keep: 42 }).ok, false)
})

test('scale values: 1–5 only; "na" refused since v1.279.2 (no question offers it any more)', () => {
  for (const v of ['1', '2', '3', '4', '5']) assert.equal(validateAnswers({ ...BASE, satisfaction: v }).ok, true, v)
  assert.equal(validateAnswers({ ...BASE, efficiency: 'na' }).ok, false)
  assert.equal(validateAnswers({ ...BASE, satisfaction: 'na' }).ok, false)
  for (const bad of ['0', '6', 4, '4.5', ['4']]) assert.equal(validateAnswers({ ...BASE, satisfaction: bad }).ok, false, String(bad))
})

test('unknown teams, unknown options, wrong types and non-objects are refused', () => {
  assert.equal(vaT({ ...BASE, team: 'queue' }).ok, false)
  assert.equal(vaT({ ...BASE, useful: ['status', 'hack'] }).ok, false)
  assert.equal(vaT({ ...BASE, useful: 'status' }).ok, false)
  assert.equal(vaT(null).ok, false)
  assert.equal(vaT([BASE]).ok, false)
})

test('multi choices: deduped, "none" is exclusive, stray other-text is dropped (no "อื่น ๆ" since v1.279.3)', () => {
  const r = vaT({ ...BASE, useful: ['status', 'status', 'calendar'], useful_other: '  ลิงก์ Drive  ' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.answers.useful, ['status', 'calendar'])
    assert.equal(r.answers.useful_other, undefined)
  }
  assert.equal(vaT({ ...BASE, useful: ['none', 'status'] }).ok, false)
  assert.equal(vaT({ ...BASE, useful: ['none'] }).ok, true)
  // the gate still enforces the cap where a question offers the box
  const withOther = { ...TEST, questions: TEST.questions.map(q => q.id === 'useful' ? { ...q, other: true } : q) }
  assert.equal(validateAnswers({ ...BASE, useful_other: 'x'.repeat(OTHER_MAX + 1) }, withOther).ok, false)
})

test('free text is trimmed, optional, and capped', () => {
  const r = validateAnswers({ ...BASE, improve: '  เลื่อนวันได้เลย  ' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.answers.improve, 'เลื่อนวันได้เลย')
  assert.equal(validateAnswers({ ...BASE, improve: 'x'.repeat(TEXT_MAX + 1) }).ok, false)
  assert.equal(validateAnswers({ ...BASE, improve: 42 }).ok, false)
})

test('definition sanity: unique option ids, exclusive exists, scales have 5 labels, every team is answerable', () => {
  for (const q of SURVEY.questions) {
    const ids = (q.options || []).map(o => o.id)
    assert.equal(new Set(ids).size, ids.length, q.id)
    if (q.exclusive) assert.ok(ids.includes(q.exclusive), q.id)
    if (q.kind === 'scale') assert.equal(q.scale?.length, 5, q.id)
  }
  for (const t of TEAMS) assert.equal(validateAnswers({ ...BASE, team: t.id }).ok, true, t.id)
})

test('summary: averages ignore "na", a 1–2 person remainder folds the smallest shown team too, texts collected', () => {
  const row = (group: string, answers: Record<string, unknown>) => ({ group, answers })
  const s = summarize([
    row('nws', { efficiency: '5', satisfaction: '4', useful: ['status', 'calendar'], keep: 'ดูสถานะง่าย' }),
    row('nws', { efficiency: '4', satisfaction: '4', useful: ['status'], improve: 'อยากเลื่อนวันได้', change: 'ฟอร์มยาว' }),
    row('nws', { efficiency: 'na', satisfaction: '2', useful: ['none'] }),
    row('pm', { efficiency: '2', satisfaction: '3', useful_other: 'ห้อง' }),
    row('queue', { efficiency: '5', satisfaction: '5' }),            // unknown team → ignored entirely
  ], 3, TEST)
  assert.equal(s.total, 4)
  const eff = s.scales.efficiency
  assert.equal(eff.n, 3)
  assert.equal(eff.na, 1)
  assert.equal(eff.avg, (5 + 4 + 2) / 3)
  assert.deepEqual(eff.dist, { '1': 0, '2': 1, '3': 0, '4': 1, '5': 1 })
  assert.equal(s.scales.satisfaction.avg, (4 + 4 + 2 + 3) / 4)
  assert.equal(s.scales.satisfaction.topPct, 50)
  assert.equal(s.scales.satisfaction.bottomPct, 25)
  // pm has 1 → hidden; showing nws would make "overall − nws" = pm's answer exactly → nws folds in too
  assert.deepEqual(s.teams, [])
  assert.equal(s.smallTeams, 4)
  assert.deepEqual(s.counts.useful, { status: 2, calendar: 1, none: 1 })
  assert.equal(s.answered.useful, 4)                                // pm answered only via "อื่น ๆ" — still counts
  assert.deepEqual(s.texts.improve, ['อยากเลื่อนวันได้'])
  assert.deepEqual(s.texts.keep, ['ดูสถานะง่าย'])         // one list per typed question, never mixed
  assert.deepEqual(s.texts.change, ['ฟอร์มยาว'])
  assert.deepEqual(s.texts.other, ['ห้อง'])
})

test('summary: teams at or above the minimum are shown when nothing is left over; team averages ignore "na"', () => {
  const row = (group: string, efficiency: string) => ({ group, answers: { efficiency, satisfaction: '3' } })
  const s = summarize([row('nws', '5'), row('nws', '4'), row('nws', 'na'), row('pm', '2'), row('pm', '2'), row('pm', '3')], 3)
  assert.deepEqual(s.teams.map(t => [t.id, t.n]), [['nws', 3], ['pm', 3]])
  assert.equal(s.smallTeams, 0)
  assert.equal(s.teams[0].scales.efficiency.avg, 4.5)
  assert.equal(s.teams[0].scales.efficiency.na, 1)
  // remainder of 3 is already safe → nothing folded
  const t = summarize([...['nws', 'nws', 'nws', 'evt', 'evt', 'evt'].map(g => row(g, '4')), row('pm', '3'), row('agn', '3'), row('wlt', '3')], 3)
  assert.deepEqual(t.teams.map(x => x.id), ['nws', 'evt'])
  assert.equal(t.smallTeams, 3)
})

// v1.280.3 — the per-team sentence was removed from the respondent's screen (Nat). The promise that remains must
// still be true, and the small-team suppression still runs even though it is no longer advertised.
test('the privacy text keeps only the not-linked promise; a team below TEAM_MIN is still never shown on its own', () => {
  assert.ok(SURVEY.privacy.includes('ไม่เก็บว่าใครตอบอะไร'))
  assert.ok(!SURVEY.privacy.includes('แยกรายทีม'))
  assert.equal(summarize([{ group: 'nws', answers: { efficiency: '3', satisfaction: '3' } }]).teams.length, 0)
  const belowMin = Array.from({ length: TEAM_MIN - 1 }, () => ({ group: 'nws', answers: { efficiency: '3', satisfaction: '3' } }))
  assert.equal(summarize(belowMin).teams.length, 0)
})

test('summary of nothing is empty, not NaN', () => {
  const s = summarize([])
  assert.equal(s.total, 0)
  assert.equal(s.scales.satisfaction.avg, null)
  assert.equal(s.scales.satisfaction.topPct, null)
  assert.deepEqual(s.teams, [])
})

// v1.279.3 — admin-edited wording
test('overrides: only known ids, trimmed, empty = back to code, team stays required, scale needs 5', () => {
  assert.deepEqual(vo(null), { ok: true, value: null })
  assert.deepEqual(vo({ intro: '  ', questions: { useful: { title: '' } } }), { ok: true, value: null })
  const v = vo({ intro: ' สวัสดี ', questions: { useful: { title: ' จุดแข็ง ', required: true, options: { status: 'My Bookings', calendar: '' } }, efficiency: { scale: ['', 'b', 'c', 'd', 'e'] } } })
  assert.equal(v.ok, true)
  if (v.ok) assert.deepEqual(v.value, { intro: 'สวัสดี', questions: {
    useful: { title: 'จุดแข็ง', required: true, options: { status: 'My Bookings' } },   // only a difference from the code default is stored (TEST.useful is optional)
    efficiency: { scale: ['ไม่เห็นด้วยอย่างยิ่ง', 'b', 'c', 'd', 'e'] },
  } })
  assert.equal(vo({ questions: { nope: { title: 'x' } } }).ok, false)
  assert.equal(vo({ questions: { useful: { options: { hack: 'x' } } } }).ok, false)
  assert.equal(vo({ questions: { team: { required: false } } }).ok, false)
  assert.equal(vo({ questions: { efficiency: { scale: ['a', 'b'] } } }).ok, false)
  assert.equal(vo({ questions: { improve: { scale: ['a', 'b', 'c', 'd', 'e'] } } }).ok, false)
  assert.equal(vo({ questions: { useful: { title: 'x'.repeat(501) } } }).ok, false)
  assert.equal(vo([]).ok, false)
  // the admin form's draft shape: every question carries scale: [] and options: {} — empty means "unchanged"
  const draft = { intro: '', questions: Object.fromEntries(SURVEY.questions.map(q => [q.id, { title: '', help: '', required: q.required, scale: [], options: {} }])) }
  assert.deepEqual(vo(draft), { ok: true, value: null })
  draft.questions.improve.help = 'ทดสอบ'
  assert.deepEqual(vo(draft), { ok: true, value: { questions: { improve: { help: 'ทดสอบ' } } } })
})

test('applyOverrides: wording changes, structure (ids, kind, exclusive) does not; the gate follows required', () => {
  const S = ao({ intro: 'สวัสดี', questions: { useful: { title: 'จุดแข็ง', required: false, options: { status: 'My Bookings' } }, efficiency: { help: 'ช่วย' }, change: { required: false } } })
  assert.equal(S.intro, 'สวัสดี')
  const useful = S.questions.find(q => q.id === 'useful')!
  assert.equal(useful.title, 'จุดแข็ง')
  assert.equal(useful.required, false)
  assert.equal(useful.exclusive, 'none')
  assert.deepEqual(useful.options!.map(o => o.id), TEST.questions.find(q => q.id === 'useful')!.options!.map(o => o.id))
  assert.equal(useful.options!.find(o => o.id === 'status')!.label, 'My Bookings')
  assert.equal(S.questions.find(q => q.id === 'efficiency')!.help, 'ช่วย')
  assert.equal(TEST.questions.find(q => q.id === 'useful')!.title.startsWith('ส่วนไหน'), true)   // code untouched
  const { change: _c, ...noChange } = BASE
  assert.equal(validateAnswers(noChange, S).ok, true)      // the admin made Q5 optional
  assert.equal(validateAnswers(noChange).ok, false)        // code default: still required
  assert.equal(applyOverrides(null), SURVEY)
})

// v1.285.1 — everyone who is logged in may answer; the server tags each answer with a box (`seg`) so non-users can be measured
test('v1.285.1 — a client-sent seg is stripped by the gate (only the server may set it)', () => {
  const r = validateAnswers({ ...BASE, seg: 'booker' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal('seg' in r.answers, false)
})

test('v1.285.1 — segments are shown only when both boxes reach the minimum; scales are per box', () => {
  const row = (seg: string | undefined, satisfaction: string) => ({ group: 'nws', answers: { efficiency: '3', satisfaction, ...(seg ? { seg } : {}) } })
  const ok = summarize([row('booker', '5'), row('booker', '5'), row('booker', '4'), row('other', '2'), row('other', '2'), row('other', '3')], 3)
  assert.deepEqual(ok.segments?.map(x => [x.id, x.n]), [['booker', 3], ['other', 3]])
  assert.ok(Math.abs(ok.segments![0].scales.satisfaction.avg! - 14 / 3) < 1e-9)
  assert.ok(Math.abs(ok.segments![1].scales.satisfaction.avg! - 7 / 3) < 1e-9)
  // one box under the minimum → none shown (overall minus the other box would give that person's score)
  assert.equal(summarize([row('booker', '5'), row('booker', '5'), row('booker', '4'), row('other', '1')], 3).segments, null)
  // everyone in one box → no split to show
  assert.equal(summarize([row('booker', '5'), row('booker', '5'), row('booker', '4')], 3).segments, null)
  // 1–2 answers with no box (pre-v1.285.1 rows) would be recoverable by subtraction → hidden; 3+ is fine
  const six = [row('booker', '5'), row('booker', '5'), row('booker', '4'), row('other', '2'), row('other', '2'), row('other', '3')]
  assert.equal(summarize([...six, row(undefined, '1')], 3).segments, null)
  assert.notEqual(summarize([...six, row(undefined, '1'), row(undefined, '1'), row(undefined, '1')], 3).segments, null)
})
