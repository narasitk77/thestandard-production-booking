import { test } from 'node:test'
import assert from 'node:assert/strict'

// findTwinFolder is module-private (it needs Drive), so this locks the pure
// matching RULE it implements: the box's EP folder must be recognised as the
// twin of the landing's EP folder even though the two trees name that layer
// differently (the landing name carries the crew's van/contact note).
// Regression: exact-name-only matching moved the landing EP folder into the
// box beside the real one and split a booking's footage across two EP01s
// (seen on POP-PIV-260722-01).
function twinName(landingName: string, boxNames: string[]): string | null {
  if (boxNames.includes(landingName)) return landingName
  const lead = landingName.split(' · ')[0]?.trim()
  if (!lead || lead === landingName) return null
  return boxNames.find(n => n === lead || n.startsWith(`${lead} `)) ?? null
}

test('landing EP folder matches the box EP folder by its immutable lead', () => {
  const box = ['EP01 · THE INTERVIEW [PICK A CARD] หมาก ปริญ-อิ้งค์', 'CAM-A', '_SHOOT.txt']
  assert.equal(
    twinName('EP01 · THE INTERVIEW [PICK A CARD] หมาก ปริญ-อิ้งค์ (รถ. 22. ก.ค)', box),
    'EP01 · THE INTERVIEW [PICK A CARD] หมาก ปริญ-อิ้งค์',
  )
  // exact match still wins
  assert.equal(twinName('CAM-A', box), 'CAM-A')
  // a camera/AUDIO name has no lead segment — never fuzzy-matched
  assert.equal(twinName('CAM-B', box), null)
  assert.equal(twinName('AUDIO', ['AUDIO x', 'CAM-A']), null)
  // EP01 must not cross-match EP010 / EP01x
  assert.equal(twinName('EP01 · x', ['EP010 · y']), null)
  assert.equal(twinName('EP01 · x', ['EP01']), 'EP01')
})
