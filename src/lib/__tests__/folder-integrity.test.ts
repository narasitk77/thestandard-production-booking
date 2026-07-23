import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAppShapedName, landingWindow, groupEpisodeFoldersByLead, buildDailyDigest } from '../folder-integrity'

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

// v1.153 — the daily Discord digest is built from AUDIT ROWS, not in-memory
// counters (this app redeploys several times a day, which would zero them).
test('buildDailyDigest: rolls up a day of runs with examples', () => {
  const { text, totalFixed } = buildDailyDigest([
    { changes: { camCreated: 3, camNormalized: 1, warnings: 2, errors: 0, checked: 60,
        actions: ['TSS-X: create CAM-A', 'TSS-X: normalize "Cam B" → "CAM-B"'],
        warningLines: ['AGN-1: มีกล่องโปรเจกต์แต่ยังไม่มีโฟลเดอร์ของคิวนี้'] } },
    { changes: { camCreated: 2, epCreated: 1, warnings: 1, errors: 0, checked: 60,
        actions: ['NWS-Y: create EP "EP01 · x"'], warningLines: ['NWS-Y: ชื่อไม่ตรง'] } },
  ])
  assert.equal(totalFixed, 7) // 3+1+2+1
  assert.match(text, /ตรวจ 2 รอบ/)
  assert.match(text, /สร้างช่องกล้อง\/เสียง: \*\*5\*\*/)
  assert.match(text, /แก้ชื่อกล้องให้เป็นมาตรฐาน: \*\*1\*\*/)
  assert.match(text, /create CAM-A/)          // a real example, not just counts
  assert.match(text, /ต้องดูเอง 3 รายการ/)     // warnings summed across runs
})

test('buildDailyDigest: a clean day says so instead of printing empty sections', () => {
  const { text, totalFixed } = buildDailyDigest([{ changes: { checked: 60, warnings: 0, errors: 0 } }])
  assert.equal(totalFixed, 0)
  assert.match(text, /ไม่มีอะไรต้องแก้/)
  assert.doesNotMatch(text, /แก้ไปแล้ว/)
})

test('buildDailyDigest: duplicate EP folders get their own alarm line', () => {
  const { text } = buildDailyDigest([{ changes: { epDuplicatesFound: 2, warnings: 2, errors: 0, warningLines: ['X: ซ้ำ'] } }])
  assert.match(text, /EP ซ้ำ 2 อัน/)
})

test('buildDailyDigest: no audit rows at all (worker idle) still renders', () => {
  const { text, totalFixed } = buildDailyDigest([])
  assert.equal(totalFixed, 0)
  assert.match(text, /ตรวจ 0 รอบ/)
})
