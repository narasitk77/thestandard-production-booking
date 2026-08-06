// v1.166 — the gate that backs the anonymity promise on the review form.
// If any of these ever go red, crew are being told something untrue.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  canReadReviews, reviewOwnerEmails, targetsFor, isValidScore,
  isReviewTargetRole, ANONYMITY_NOTICE_TH,
} from '../review-access'

let saved: string | undefined
beforeEach(() => { saved = process.env.REVIEW_OWNER_EMAILS; delete process.env.REVIEW_OWNER_EMAILS })
afterEach(() => { if (saved === undefined) delete process.env.REVIEW_OWNER_EMAILS; else process.env.REVIEW_OWNER_EMAILS = saved })

test('exactly the three named people can read reviews', () => {
  for (const e of ['narasit.k@thestandard.co', 'panu.w@thestandard.co', 'chonlathorn.j@thestandard.co']) {
    assert.equal(canReadReviews(e), true, e)
  }
  assert.equal(reviewOwnerEmails().length, 3)
})

test('everyone else is refused — including other admins and the crew being rated', () => {
  for (const e of [
    'aomtian.t@thestandard.co',      // an outlet producer
    'video@thestandard.co',          // the camera team inbox
    'sound@thestandard.co',
    'rujira.k@thestandard.co',
    'someone@evil.com',
    '', null, undefined,
  ] as const) {
    assert.equal(canReadReviews(e as any), false, String(e))
  }
})

test('matching is case- and whitespace-insensitive (session emails vary)', () => {
  assert.equal(canReadReviews('  NARASIT.K@thestandard.co '), true)
  assert.equal(canReadReviews('Panu.W@THESTANDARD.CO'), true)
})

test('REVIEW_OWNER_EMAILS REPLACES the list — it never extends it silently', () => {
  process.env.REVIEW_OWNER_EMAILS = 'boss@thestandard.co'
  assert.equal(canReadReviews('boss@thestandard.co'), true)
  // the defaults are gone: the set is exactly what the env says
  assert.equal(canReadReviews('narasit.k@thestandard.co'), false)
})

test('a junk env value falls back to the named three, never to an empty gate', () => {
  for (const junk of ['', '   ', ',,,', ' , , ']) {
    process.env.REVIEW_OWNER_EMAILS = junk
    assert.equal(reviewOwnerEmails().length, 3, `junk=${JSON.stringify(junk)}`)
    assert.equal(canReadReviews('narasit.k@thestandard.co'), true)
    assert.equal(canReadReviews('anyone@thestandard.co'), false)
  }
})

test('mutual review: you rate every team on the shoot except your own', () => {
  assert.deepEqual(targetsFor('producer', ['producer', 'camera', 'sound']), ['camera', 'sound'])
  assert.deepEqual(targetsFor('camera', ['producer', 'camera', 'sound']), ['producer', 'sound'])
  assert.deepEqual(targetsFor('sound', ['producer', 'camera', 'sound']), ['producer', 'camera'])
  // a shoot with no sound team: nobody is asked about sound
  assert.deepEqual(targetsFor('producer', ['producer', 'camera']), ['camera'])
  // a role not on the shoot still never rates itself
  assert.deepEqual(targetsFor('other', ['producer', 'camera']), ['producer', 'camera'])
})

test('scores are integers 1..5 — no clamping, no strings, no half stars', () => {
  for (const ok of [1, 2, 3, 4, 5]) assert.equal(isValidScore(ok), true, String(ok))
  for (const bad of [0, 6, -1, 3.5, '4', null, undefined, NaN, Infinity]) {
    assert.equal(isValidScore(bad as any), false, String(bad))
  }
})

test('only the three known target roles are accepted', () => {
  assert.equal(isReviewTargetRole('camera'), true)
  assert.equal(isReviewTargetRole('editor'), false)
  assert.equal(isReviewTargetRole(''), false)
})

test('the notice shown to raters states the real audience, not "fully anonymous"', () => {
  // The gate lets 3 people see raw rows, so the copy must say so. A promise of
  // total anonymity here would be a lie the code cannot keep.
  assert.match(ANONYMITY_NOTICE_TH, /ผู้ดูแลระบบ 3 คน/)
  assert.match(ANONYMITY_NOTICE_TH, /ไม่ถูกเปิดเผยต่อผู้ถูกประเมิน/)
})
