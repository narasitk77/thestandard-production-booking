import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAppShapedName, landingWindow, groupEpisodeFoldersByLead } from '../folder-integrity'

// The rename guard: only names the APP generates may be re-derived. Anything a
// human authored keeps its name (a rename of a folder holding footage is not
// undoable from Drive trash, and ops label boxes on purpose).
test('isAppShapedName: accepts only the shapes this codebase produces', () => {
  const code = 'AGN-260722-01'
  // v1.110 shape — code trails in parens
  assert.equal(isAppShapedName(`PEA (ผู้ว่าการการไฟฟ้าส่วนภูมิภาค) (${code})`, code), true)
  // legacy shape — code leads
  assert.equal(isAppShapedName(`${code} · PEA`, code), true)
  // bare code
  assert.equal(isAppShapedName(code, code), true)
  // ops-authored label that merely MENTIONS the code mid-name → hands off
  assert.equal(isAppShapedName(`ห้ามลบ ${code} ของพี่ต้น`, code), false)
  // another booking's folder must never qualify
  assert.equal(isAppShapedName('PEA (AGN-260722-02)', code), false)
  assert.equal(isAppShapedName('', code), false)
  assert.equal(isAppShapedName(`PEA (${code})`, ''), false)
})

// Duplicate-EP detection (v1.152.1). Eight of these accumulated in prod before
// v1.151.3 stopped video-merge creating them, and nothing reported it — the
// crew found them. This is the grouping rule the standing check uses.
test('groupEpisodeFoldersByLead: two folders sharing an EP lead are a duplicate', () => {
  const epNames = ['EP01 · Passion Calling x Tonhon (Producer)']
  const kids = [
    { id: 'a', name: 'EP01 · Passion Calling x Tonhon (Producer)' },
    { id: 'b', name: 'EP01 · Passion Calling x Tonhon (Producer) (รถ. 23. ก.ค พี่จาบ)' },
    { id: 'c', name: 'CAM-A' },
    { id: 'd', name: '_SHOOT.txt' },
  ]
  const groups = groupEpisodeFoldersByLead(kids, epNames)
  assert.deepEqual(Array.from(groups.keys()), ['EP01'])
  assert.deepEqual(groups.get('EP01')!.map(g => g.id), ['a', 'b'])
})

test('groupEpisodeFoldersByLead: never groups folders that are not this booking\'s episodes', () => {
  const epNames = ['EP01 · Interview']
  // A crew-made folder that happens to contain a middle dot must not be read
  // as an EP layer, and another booking's EP lead must not be grouped either.
  const kids = [
    { id: 'a', name: 'EP01 · Interview' },
    { id: 'b', name: 'Cam A · backup ของพี่ต้น' },
    { id: 'c', name: 'EP02 · Interview' },
    { id: 'd', name: 'AUDIO' },
  ]
  const groups = groupEpisodeFoldersByLead(kids, epNames)
  assert.deepEqual(Array.from(groups.keys()), ['EP01'])
  assert.equal(groups.get('EP01')!.length, 1) // single → not a duplicate
})

test('groupEpisodeFoldersByLead: EP01 must not swallow EP010', () => {
  const groups = groupEpisodeFoldersByLead(
    [{ id: 'a', name: 'EP01 · x' }, { id: 'b', name: 'EP010 · y' }],
    ['EP01 · x', 'EP010 · y'],
  )
  assert.equal(groups.get('EP01')!.length, 1)
  assert.equal(groups.get('EP010')!.length, 1)
})

test('landingWindow: TODAY only in Bangkok, spanning multi-day shoots', () => {
  // 2026-07-22 18:00 BKK = 11:00 UTC
  const now = new Date('2026-07-22T11:00:00Z')
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

  assert.equal(landingWindow(day('2026-07-22'), null, now), true)  // today
  // tomorrow belongs to the 19:00 lifecycle — creating it here would just feed
  // the ~12:00 prune=today cleanup a fresh folder to bin every day
  assert.equal(landingWindow(day('2026-07-23'), null, now), false)
  assert.equal(landingWindow(day('2026-07-24'), null, now), false) // day after
  assert.equal(landingWindow(day('2026-07-21'), null, now), false) // yesterday
  // a multi-day shoot that STARTED before today but runs through it still needs
  // its drop folder (the v1.146 shootEndDate lesson)
  assert.equal(landingWindow(day('2026-07-20'), day('2026-07-23'), now), true)
  assert.equal(landingWindow(day('2026-07-18'), day('2026-07-21'), now), false)
  // a multi-day shoot starting tomorrow is still the lifecycle's job
  assert.equal(landingWindow(day('2026-07-23'), day('2026-07-25'), now), false)
})
