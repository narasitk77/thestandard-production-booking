import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAppShapedName, landingWindow } from '../folder-integrity'

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
