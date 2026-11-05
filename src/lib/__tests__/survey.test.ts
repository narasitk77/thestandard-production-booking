// v1.279 — the survey's answer gate and its summary.
// The gate decides what lands in survey_responses; the summary is what the admin page shows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnswers, summarize, SURVEY, TEAMS, TEAM_MIN, TEXT_MAX, OTHER_MAX } from '../survey'

const BASE = { team: 'nws', efficiency: '4', satisfaction: '3' }

test('a complete answer passes; team goes to group, unknown keys are stripped', () => {
  const r = validateAnswers({ ...BASE, smuggled: 'x', role: 'queue' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.group, 'nws')
  assert.deepEqual(r.answers, { efficiency: '4', satisfaction: '3' })
})

test('team and both scales are required; optional questions may be left out', () => {
  const { team, ...noTeam } = BASE
  assert.equal(validateAnswers(noTeam).ok, false)
  const { efficiency, ...noEff } = BASE
  assert.equal(validateAnswers(noEff).ok, false)
  const { satisfaction, ...noSat } = BASE
  assert.equal(validateAnswers(noSat).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: [], improve: '' }).ok, true)
})

test('scale values: 1–5 only, "na" only where the question offers it', () => {
  for (const v of ['1', '2', '3', '4', '5']) assert.equal(validateAnswers({ ...BASE, satisfaction: v }).ok, true, v)
  assert.equal(validateAnswers({ ...BASE, efficiency: 'na' }).ok, true)
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

test('multi choices: deduped, "none" is exclusive, other text kept and capped', () => {
  const r = validateAnswers({ ...BASE, useful: ['status', 'status', 'calendar'], useful_other: '  ลิงก์ Drive  ' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.answers.useful, ['status', 'calendar'])
    assert.equal(r.answers.useful_other, 'ลิงก์ Drive')
  }
  assert.equal(validateAnswers({ ...BASE, useful: ['none', 'status'] }).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful: ['none'], useful_other: 'x' }).ok, false)
  assert.equal(validateAnswers({ ...BASE, useful_other: 'x'.repeat(OTHER_MAX + 1) }).ok, false)
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

test('the privacy promise shown to respondents quotes the same minimum the summary enforces', () => {
  assert.ok(SURVEY.privacy.includes(`${TEAM_MIN} คน`))
  assert.equal(summarize([{ group: 'nws', answers: { efficiency: '3', satisfaction: '3' } }]).teams.length, 0)
})

test('summary of nothing is empty, not NaN', () => {
  const s = summarize([])
  assert.equal(s.total, 0)
  assert.equal(s.scales.satisfaction.avg, null)
  assert.equal(s.scales.satisfaction.topPct, null)
  assert.deepEqual(s.teams, [])
})
