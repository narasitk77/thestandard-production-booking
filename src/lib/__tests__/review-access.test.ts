// v1.166 — the gate that backs the anonymity promise on the review form.
// If any of these ever go red, crew are being told something untrue.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  canReadReviewContent, canSeeReviewActivity, reviewContentReaderEmails,
  reviewActivityReaderEmails, targetsFor, isValidScore,
  isReviewTargetRole, ANONYMITY_NOTICE_TH,
} from '../review-access'

const ENVS = ['REVIEW_CONTENT_READER_EMAILS', 'REVIEW_ACTIVITY_READER_EMAILS'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = {}
  for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENVS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]!
  }
})

const MANAGERS = ['panu.w@thestandard.co', 'chonlathorn.j@thestandard.co']
const OPERATOR = 'narasit.k@thestandard.co'

test('only the managers read the messages', () => {
  for (const e of MANAGERS) assert.equal(canReadReviewContent(e), true, e)
  assert.deepEqual(reviewContentReaderEmails().sort(), [...MANAGERS].sort())
})

test('THE POINT OF v1.173.4: the operator sees that feedback exists, never what it says', () => {
  // He runs the system, sits on the crew list and is often the producer being
  // rated. A system owner who can read every complaint about himself is a system
  // nobody complains in.
  assert.equal(canReadReviewContent(OPERATOR), false, 'operator must NOT read content')
  assert.equal(canSeeReviewActivity(OPERATOR), true, 'operator must still see the pipeline')
})

test('managers see strictly more than the operator, never less', () => {
  for (const e of MANAGERS) assert.equal(canSeeReviewActivity(e), true, e)
})

test('everyone else is refused at BOTH tiers — other admins and the crew being rated', () => {
  for (const e of [
    'aomtian.t@thestandard.co',      // an outlet producer
    'video@thestandard.co',          // the camera team inbox
    'sound@thestandard.co',
    'rujira.k@thestandard.co',
    'someone@evil.com',
    '', null, undefined,
  ] as const) {
    assert.equal(canReadReviewContent(e as any), false, `content: ${String(e)}`)
    assert.equal(canSeeReviewActivity(e as any), false, `activity: ${String(e)}`)
  }
})

test('matching is case- and whitespace-insensitive (session emails vary)', () => {
  assert.equal(canReadReviewContent('Panu.W@THESTANDARD.CO'), true)
  assert.equal(canSeeReviewActivity('  NARASIT.K@thestandard.co '), true)
  // ...and case games do not get anyone past the content gate either
  assert.equal(canReadReviewContent('  NARASIT.K@thestandard.co '), false)
})

test('each env REPLACES its list — it never extends it silently', () => {
  process.env.REVIEW_CONTENT_READER_EMAILS = 'boss@thestandard.co'
  assert.equal(canReadReviewContent('boss@thestandard.co'), true)
  // the defaults are gone: the set is exactly what the env says
  for (const e of MANAGERS) assert.equal(canReadReviewContent(e), false, e)
  // a new content reader also gets activity, without being listed there
  assert.equal(canSeeReviewActivity('boss@thestandard.co'), true)
})

test('handing the operator content access takes an explicit env change', () => {
  // Not a thing that can happen by accident — which is the guarantee the notice
  // on the form makes to the staff.
  process.env.REVIEW_CONTENT_READER_EMAILS = `${MANAGERS[0]},${OPERATOR}`
  assert.equal(canReadReviewContent(OPERATOR), true)
})

test('junk env falls back to the defaults — never to an open gate, never to nobody', () => {
  for (const junk of ['', '   ', ',,,', ' , , ']) {
    process.env.REVIEW_CONTENT_READER_EMAILS = junk
    process.env.REVIEW_ACTIVITY_READER_EMAILS = junk
    assert.equal(reviewContentReaderEmails().length, 2, `junk=${JSON.stringify(junk)}`)
    assert.equal(reviewActivityReaderEmails().length, 1, `junk=${JSON.stringify(junk)}`)
    for (const e of MANAGERS) assert.equal(canReadReviewContent(e), true, e)
    assert.equal(canReadReviewContent(OPERATOR), false)
    assert.equal(canSeeReviewActivity(OPERATOR), true)
    assert.equal(canReadReviewContent('anyone@thestandard.co'), false)
    assert.equal(canSeeReviewActivity('anyone@thestandard.co'), false)
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

test('the notice shown to raters names the REAL readers, and only them', () => {
  // The sentence and the gate have to agree or the app is lying to its own staff.
  // v1.173.4 broke the old copy: it named the operator as a reader, and it called
  // the managers "ผู้ดูแลระบบ".
  assert.match(ANONYMITY_NOTICE_TH, /ไม่ถูกเปิดเผยต่อผู้ถูกประเมิน/)
  assert.match(ANONYMITY_NOTICE_TH, /หัวหน้าทีม 2 คน/)
  assert.match(ANONYMITY_NOTICE_TH, /ผู้ดูแลระบบเห็นเพียงว่ามีการส่ง ไม่เห็นข้อความ/)
  assert.doesNotMatch(ANONYMITY_NOTICE_TH, /ผู้ดูแลระบบ 3 คน/, 'the operator no longer reads')
  assert.doesNotMatch(ANONYMITY_NOTICE_TH, /นัท/, 'the operator must not be listed as a reader')
})

// ── v1.166.1 — the anonymity promise, pinned against the way it actually broke ──

test('REGRESSION: review audit actions must never be readable on a booking timeline', async () => {
  // How the leak worked: POST /api/review/:token wrote entityType 'Booking' +
  // { raterRole } into AuditLog, and GET /api/bookings/:id/history returns every
  // 'Booking' row — changes payload included — to ANY signed-in user. One sound
  // engineer on a shoot means "the sound team rated you" names a person.
  const { isPubliclyVisibleAction } = await import('../booking-history-visibility')
  assert.equal(isPubliclyVisibleAction('review.submitted'), false)

  // And the row is no longer written against the booking at all — belt and
  // braces, because the filter above protects only THIS endpoint.
  const fs = await import('fs')
  const src = fs.readFileSync(new URL('../../app/api/review/[token]/route.ts', import.meta.url), 'utf8')
  const auditBlock = src.slice(src.indexOf('logAudit('), src.indexOf('logAudit(') + 500)
  assert.doesNotMatch(auditBlock, /entityType:\s*'Booking'/, 'review audit must not use entityType Booking')
  assert.doesNotMatch(auditBlock, /raterRole/, 'review audit must not carry the rater team')
  assert.doesNotMatch(auditBlock, /bookingCode/, 'review audit must not carry a bookingCode (history matches on it)')
})

test('REGRESSION: the raw token is never written into an audit payload', async () => {
  const fs = await import('fs')
  for (const f of ['../../app/api/review/[token]/route.ts', '../../app/api/internal/shoot-reviews/send/route.ts']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    const blocks = src.split('logAudit(').slice(1).map(b => b.slice(0, 500))
    for (const b of blocks) {
      assert.doesNotMatch(b, /token:\s*(params\.)?token\b/, `raw token in an audit payload in ${f}`)
    }
  }
})
