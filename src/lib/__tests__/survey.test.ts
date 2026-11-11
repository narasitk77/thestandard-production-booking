// v1.279 — the survey's answer gate and its summary.
// The gate decides what lands in survey_responses; the summary is what the admin page shows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnswers, summarize, applyOverrides, validateOverrides, SURVEY, TEAMS, TEAM_MIN, TEXT_MAX, OTHER_MAX } from '../survey'

// v1.279.2 — `useful` (strengths to keep) is required; v1.284.1 — so is `fix` (what to improve first), so the base answer carries one pick of each
const BASE = { team: 'nws', efficiency: '4', satisfaction: '3', useful: ['status'], fix: ['form'] }

test('a complete answer passes; team goes to group, unknown keys are stripped', () => {
  const r = validateAnswers({ ...BASE, smuggled: 'x', role: 'queue' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.group, 'nws')
  assert.deepEqual(r.answers, { efficiency: '4', satisfaction: '3', useful: ['status'], fix: ['form'] })
})

test('team, both scales and the strengths pick are required; free text may be left out', () => {
  const { team, ...noTeam } = BASE
  assert.equal(validateAnswers(noTeam).ok, false)
  const { efficiency, ...noEff } = BASE
  assert.equal(validateAnswers(noEff).ok, false)
  const { satisfaction, ...noSat } = BASE
  assert.equal(validateAnswers(noSat).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: [] }).ok, false)
  const { useful, ...noUseful } = BASE
  assert.equal(validateAnswers(noUseful).ok, false)
  assert.equal(validateAnswers({ ...noUseful, useful_other: 'ลิงก์' }).ok, false)  // no "อื่น ๆ" box since v1.279.3 — free text can't stand in
  assert.equal(validateAnswers({ ...BASE, improve: '' }).ok, true)
})

test('v1.284.1 — `fix` is required like `useful`, shares its option list, "none" is exclusive, nothing outside the list passes', () => {
  const { fix, ...noFix } = BASE
  assert.equal(validateAnswers(noFix).ok, false)
  assert.equal(validateAnswers({ ...BASE, fix: [] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, fix: ['none'] }).ok, true)
  assert.equal(validateAnswers({ ...BASE, fix: ['none', 'form'] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, fix: ['hack'] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, fix: ['form', 'capacity', 'folder'] }).ok, true)
  const ids = (id: string) => SURVEY.questions.find(q => q.id === id)!.options!.map(o => o.id)
  assert.deepEqual(ids('fix'), ids('useful'))   // one list: "liked" vs "fix first" compare per feature
  assert.ok(ids('useful').includes('form'))
})

test('scale values: 1–5 only; "na" refused since v1.279.2 (no question offers it any more)', () => {
  for (const v of ['1', '2', '3', '4', '5']) assert.equal(validateAnswers({ ...BASE, satisfaction: v }).ok, true, v)
  assert.equal(validateAnswers({ ...BASE, efficiency: 'na' }).ok, false)
  assert.equal(validateAnswers({ ...BASE, satisfaction: 'na' }).ok, false)
  for (const bad of ['0', '6', 4, '4.5', ['4']]) assert.equal(validateAnswers({ ...BASE, satisfaction: bad }).ok, false, String(bad))
})

test('unknown teams, unknown options, wrong types and non-objects are refused', () => {
  assert.equal(validateAnswers({ ...BASE, team: 'queue' }).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: ['status', 'hack'] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: 'status' }).ok, false)
  assert.equal(validateAnswers(null).ok, false)
  assert.equal(validateAnswers([BASE]).ok, false)
})

test('multi choices: deduped, "none" is exclusive, stray other-text is dropped (no "อื่น ๆ" since v1.279.3)', () => {
  const r = validateAnswers({ ...BASE, useful: ['status', 'status', 'calendar'], useful_other: '  ลิงก์ Drive  ' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.answers.useful, ['status', 'calendar'])
    assert.equal(r.answers.useful_other, undefined)
  }
  assert.equal(validateAnswers({ ...BASE, useful: ['none', 'status'] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: ['none'] }).ok, true)
  // the gate still enforces the cap where a question offers the box
  const withOther = { ...SURVEY, questions: SURVEY.questions.map(q => q.id === 'useful' ? { ...q, other: true } : q) }
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
    row('nws', { efficiency: '5', satisfaction: '4', useful: ['status', 'calendar'] }),
    row('nws', { efficiency: '4', satisfaction: '4', useful: ['status'], improve: 'อยากเลื่อนวันได้' }),
    row('nws', { efficiency: 'na', satisfaction: '2', useful: ['none'] }),
    row('pm', { efficiency: '2', satisfaction: '3', useful_other: 'ห้อง' }),
    row('queue', { efficiency: '5', satisfaction: '5' }),            // unknown team → ignored entirely
  ], 3)
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
  assert.deepEqual(validateOverrides(null), { ok: true, value: null })
  assert.deepEqual(validateOverrides({ intro: '  ', questions: { useful: { title: '' } } }), { ok: true, value: null })
  const v = validateOverrides({ intro: ' สวัสดี ', questions: { useful: { title: ' จุดแข็ง ', required: false, options: { status: 'My Bookings', calendar: '' } }, efficiency: { scale: ['', 'b', 'c', 'd', 'e'] } } })
  assert.equal(v.ok, true)
  if (v.ok) assert.deepEqual(v.value, { intro: 'สวัสดี', questions: {
    useful: { title: 'จุดแข็ง', required: false, options: { status: 'My Bookings' } },
    efficiency: { scale: ['ไม่เห็นด้วยอย่างยิ่ง', 'b', 'c', 'd', 'e'] },
  } })
  assert.equal(validateOverrides({ questions: { nope: { title: 'x' } } }).ok, false)
  assert.equal(validateOverrides({ questions: { useful: { options: { hack: 'x' } } } }).ok, false)
  assert.equal(validateOverrides({ questions: { team: { required: false } } }).ok, false)
  assert.equal(validateOverrides({ questions: { efficiency: { scale: ['a', 'b'] } } }).ok, false)
  assert.equal(validateOverrides({ questions: { improve: { scale: ['a', 'b', 'c', 'd', 'e'] } } }).ok, false)
  assert.equal(validateOverrides({ questions: { useful: { title: 'x'.repeat(501) } } }).ok, false)
  assert.equal(validateOverrides([]).ok, false)
  // the admin form's draft shape: every question carries scale: [] and options: {} — empty means "unchanged"
  const draft = { intro: '', questions: Object.fromEntries(SURVEY.questions.map(q => [q.id, { title: '', help: '', required: q.required, scale: [], options: {} }])) }
  assert.deepEqual(validateOverrides(draft), { ok: true, value: null })
  draft.questions.improve.help = 'ทดสอบ'
  assert.deepEqual(validateOverrides(draft), { ok: true, value: { questions: { improve: { help: 'ทดสอบ' } } } })
})

test('applyOverrides: wording changes, structure (ids, kind, exclusive) does not; the gate follows required', () => {
  const S = applyOverrides({ intro: 'สวัสดี', questions: { useful: { title: 'จุดแข็ง', required: false, options: { status: 'My Bookings' } }, efficiency: { help: 'ช่วย' } } })
  assert.equal(S.intro, 'สวัสดี')
  const useful = S.questions.find(q => q.id === 'useful')!
  assert.equal(useful.title, 'จุดแข็ง')
  assert.equal(useful.required, false)
  assert.equal(useful.exclusive, 'none')
  assert.deepEqual(useful.options!.map(o => o.id), SURVEY.questions.find(q => q.id === 'useful')!.options!.map(o => o.id))
  assert.equal(useful.options!.find(o => o.id === 'status')!.label, 'My Bookings')
  assert.equal(S.questions.find(q => q.id === 'efficiency')!.help, 'ช่วย')
  assert.equal(SURVEY.questions.find(q => q.id === 'useful')!.title.startsWith('ส่วนไหน'), true)   // code untouched
  const { useful: _u, ...noUseful } = BASE
  assert.equal(validateAnswers(noUseful, S).ok, true)
  assert.equal(validateAnswers(noUseful).ok, false)
  assert.equal(applyOverrides(null), SURVEY)
})
