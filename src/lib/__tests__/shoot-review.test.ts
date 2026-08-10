// v1.166 — who gets asked to review whom. The rules here decide whether a
// person is ever asked to rate their own team (they must not be) and whether a
// pointless form goes out to a one-team shoot (it must not).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRater, presentRoles, buildInvites, newInviteToken, tokenFingerprint,
  isCriterionKey, reviewDelayDays, REVIEW_CRITERIA,
  reviewLookbackDays, reviewMaxBookingsPerRun, dueWindow,
  isInvitableEmail, reviewExcludedEmails, reviewAllowedDomains, buildInviteMail,
} from '../shoot-review'
import {
  OVERALL_TARGET, isOverallTarget, isSubmittableTarget, isReviewTargetRole,
  targetsFor, REVIEW_TARGET_ROLES, isCrewRole, overallLabelFor,
  OVERALL_TH, OVERALL_TH_CREW, MAIL_CONFIDENTIAL_TH,
} from '../review-access'

const base = {
  id: 'b1', bookingCode: 'NWS-260817-01', shootDate: new Date('2026-08-17'),
  status: 'CONFIRMED', deletedAt: null,
  producerEmail: 'pd@thestandard.co', createdByEmail: 'pd@thestandard.co',
  assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co'],
  mainVideographerEmail: 'cam@thestandard.co',
  crewRequired: ['Videographer', 'Sound'],
}
const roster = { 'cam@thestandard.co': 'video', 'snd@thestandard.co': 'sound', 'pd@thestandard.co': 'producer' }

test('everyone is asked about the OTHER teams and never about their own', () => {
  const invites = buildInvites(base, roster)
  const byEmail = Object.fromEntries(invites.map(i => [i.email, i]))
  assert.deepEqual(byEmail['pd@thestandard.co'].targets, ['camera', 'sound'])
  assert.deepEqual(byEmail['cam@thestandard.co'].targets, ['producer', 'sound'])
  assert.deepEqual(byEmail['snd@thestandard.co'].targets, ['producer', 'camera'])
  for (const i of invites) assert.ok(!i.targets.includes(i.role as any), `${i.email} rates own team`)
})

test('review is mutual — the camera team really does rate the producer back', () => {
  const cam = buildInvites(base, roster).find(i => i.email === 'cam@thestandard.co')!
  assert.ok(cam.targets.includes('producer'))
})

test('a shoot with only one team gets NO invites (nobody to rate)', () => {
  const soloBooking = {
    ...base, assignedEmails: [], mainVideographerEmail: null,
    crewRequired: [], producerEmail: 'pd@thestandard.co', createdByEmail: 'pd@thestandard.co',
  }
  assert.deepEqual(buildInvites(soloBooking, roster), [])
})

test('cancelled and deleted bookings are never surveyed', () => {
  assert.deepEqual(buildInvites({ ...base, status: 'CANCELLED' }, roster), [])
  assert.deepEqual(buildInvites({ ...base, deletedAt: new Date() }, roster), [])
})

test('a booking with nobody assigned produces nothing', () => {
  assert.deepEqual(buildInvites({
    ...base, assignedEmails: [], mainVideographerEmail: null,
    producerEmail: null, createdByEmail: null,
  }, roster), [])
})

test('rater classification: producer / main videographer / roster role / unknown', () => {
  const b = { producerEmail: 'pd@x', createdByEmail: 'maker@x', mainVideographerEmail: 'cam@x' }
  assert.equal(classifyRater('pd@x', b, {}), 'producer')
  assert.equal(classifyRater('maker@x', b, {}), 'producer')
  assert.equal(classifyRater('cam@x', b, {}), 'camera')
  assert.equal(classifyRater('s@x', b, { 's@x': 'sound' }), 'sound')
  assert.equal(classifyRater('p@x', b, { 'p@x': 'photo' }), 'camera')   // photo counts as camera side
  assert.equal(classifyRater('d@x', b, { 'd@x': 'director' }), 'camera')
  assert.equal(classifyRater('who@x', b, {}), 'other')
  assert.equal(classifyRater('  PD@X  ', b, {}), 'producer')            // trims + lowercases
})

test('an "other" role still rates every team present, and is rated by none', () => {
  const invites = buildInvites({ ...base, assignedEmails: ['cam@thestandard.co', 'snd@thestandard.co', 'x@thestandard.co'] }, roster)
  const other = invites.find(i => i.email === 'x@thestandard.co')!
  assert.equal(other.role, 'other')
  assert.deepEqual(other.targets, ['producer', 'camera', 'sound'])
})

test('sound is a target when the job requested Sound even if nobody was tagged yet', () => {
  assert.ok(presentRoles({ crewRequired: ['Sound'], producerEmail: 'p@x', createdByEmail: null }, ['producer']).includes('sound'))
  assert.ok(!presentRoles({ crewRequired: [], producerEmail: 'p@x', createdByEmail: null }, ['producer']).includes('sound'))
})

test('target order is stable so the form never reshuffles between people', () => {
  assert.deepEqual(presentRoles({ crewRequired: ['Sound'], producerEmail: 'p@x', createdByEmail: null }, ['camera', 'sound']),
    ['producer', 'camera', 'sound'])
})

test('tokens are long, unique, and never logged raw (fingerprint is short + stable)', () => {
  const a = newInviteToken(), b = newInviteToken()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40, `token too short: ${a.length}`)
  assert.doesNotMatch(a, /[+/=]/) // url-safe: survives an email client
  assert.equal(tokenFingerprint(a), tokenFingerprint(a))
  assert.equal(tokenFingerprint(a).length, 12)
  assert.notEqual(tokenFingerprint(a), a.slice(0, 12)) // fingerprint ≠ prefix of the secret
})

test('the send delay defaults to 1 day and ignores junk env', () => {
  const saved = process.env.SHOOT_REVIEW_DELAY_DAYS
  delete process.env.SHOOT_REVIEW_DELAY_DAYS
  assert.equal(reviewDelayDays(), 1)
  process.env.SHOOT_REVIEW_DELAY_DAYS = 'abc'
  assert.equal(reviewDelayDays(), 1)
  process.env.SHOOT_REVIEW_DELAY_DAYS = '3'
  assert.equal(reviewDelayDays(), 3)
  if (saved === undefined) delete process.env.SHOOT_REVIEW_DELAY_DAYS
  else process.env.SHOOT_REVIEW_DELAY_DAYS = saved
})

test('criteria keys validate and every one has Thai copy', () => {
  for (const c of REVIEW_CRITERIA) { assert.equal(isCriterionKey(c.key), true); assert.ok(c.th) }
  assert.equal(isCriterionKey('vibes'), false)
})

// ── v1.166.1 — fixes from the pre-deploy adversarial review ──────────────────

test('the person who merely FILED the booking is not surveyed', () => {
  // Coordinators file bookings for other people and never go on set. Inviting
  // them made the survey feel like it was spamming the whole company.
  const invites = buildInvites({
    ...base, createdByEmail: 'coordinator@thestandard.co',
    producerEmail: 'pd@thestandard.co',
  }, roster)
  assert.equal(invites.some(i => i.email === 'coordinator@thestandard.co'), false)
  assert.equal(invites.some(i => i.email === 'pd@thestandard.co'), true)
})

test('a filer who is ALSO crew still gets asked (they were actually there)', () => {
  const invites = buildInvites({
    ...base, createdByEmail: 'cam@thestandard.co',
  }, roster)
  assert.equal(invites.some(i => i.email === 'cam@thestandard.co'), true)
})

test('invite targets are what the email promised — they are stored, not recomputed', () => {
  // The bug: the form recomputed the target list from ONE rater's role, so the
  // camera team could never appear and the producer was asked less than the
  // email said. buildInvites is the single decision point; its output is what
  // gets persisted on the invite row.
  const invites = buildInvites(base, roster)
  for (const i of invites) {
    assert.ok(i.targets.length > 0, `${i.email} got an empty target list`)
    assert.ok(!i.targets.includes(i.role as any))
  }
  const cam = invites.find(i => i.email === 'cam@thestandard.co')!
  assert.deepEqual(cam.targets, ['producer', 'sound'])
})

// ── v1.173 — COMPLETED trigger, catch-up window, overall satisfaction ────────

test('the due window covers a whole lookback band, both bounds inclusive', () => {
  // A single-day match was the bug: one morning the sender did not run and those
  // shoots were never surveyed. The window is what gives a missed run a retry.
  const today = new Date('2026-08-10T00:00:00.000Z') // Bangkok midnight, UTC Date
  const { from, to } = dueWindow(today, 1, 7)
  assert.equal(to.toISOString().slice(0, 10), '2026-08-09')   // finished ≥1 day ago
  assert.equal(from.toISOString().slice(0, 10), '2026-08-02')  // ...but not older than 7 more days
})

test('a zero lookback degrades to exactly the old single-day behaviour', () => {
  const today = new Date('2026-08-10T00:00:00.000Z')
  const { from, to } = dueWindow(today, 1, 0)
  assert.equal(from.getTime(), to.getTime())
  assert.equal(to.toISOString().slice(0, 10), '2026-08-09')
})

test('lookback and per-run cap read from env, and junk values fall back', () => {
  const savedLb = process.env.SHOOT_REVIEW_LOOKBACK_DAYS
  const savedMax = process.env.SHOOT_REVIEW_MAX_BOOKINGS
  delete process.env.SHOOT_REVIEW_LOOKBACK_DAYS
  delete process.env.SHOOT_REVIEW_MAX_BOOKINGS
  assert.equal(reviewLookbackDays(), 7)
  assert.equal(reviewMaxBookingsPerRun(), 20)
  process.env.SHOOT_REVIEW_LOOKBACK_DAYS = '2'
  process.env.SHOOT_REVIEW_MAX_BOOKINGS = '3'
  assert.equal(reviewLookbackDays(), 2)
  assert.equal(reviewMaxBookingsPerRun(), 3)
  // A cap of 0 would mean "survey nobody, quietly" — the floor is 1.
  process.env.SHOOT_REVIEW_MAX_BOOKINGS = '0'
  assert.equal(reviewMaxBookingsPerRun(), 20)
  process.env.SHOOT_REVIEW_LOOKBACK_DAYS = 'soon'
  assert.equal(reviewLookbackDays(), 7)
  if (savedLb === undefined) delete process.env.SHOOT_REVIEW_LOOKBACK_DAYS
  else process.env.SHOOT_REVIEW_LOOKBACK_DAYS = savedLb
  if (savedMax === undefined) delete process.env.SHOOT_REVIEW_MAX_BOOKINGS
  else process.env.SHOOT_REVIEW_MAX_BOOKINGS = savedMax
})

test('the overall satisfaction row is submittable but is NOT a team', () => {
  assert.equal(isSubmittableTarget(OVERALL_TARGET), true)
  assert.equal(isOverallTarget(OVERALL_TARGET), true)
  // The distinction that matters: inside REVIEW_TARGET_ROLES, targetsFor would
  // hand 'overall' out or withhold it depending on the rater's own role, so a
  // producer would be asked for overall satisfaction and a producer would not.
  assert.equal(isReviewTargetRole(OVERALL_TARGET), false)
  assert.equal(REVIEW_TARGET_ROLES.some(r => r.key === (OVERALL_TARGET as any)), false)
  const present = REVIEW_TARGET_ROLES.map(r => r.key)
  for (const role of ['producer', 'camera', 'sound']) {
    assert.equal(targetsFor(role, present).includes(OVERALL_TARGET as any), false)
  }
})

test('shared team mailboxes are not invited — they are teams, not people', () => {
  // Real prod data: video@ appeared 264 times and sound@ 205 times across 300
  // bookings, standing in for "the camera team". Mailing them meant 18 invites to
  // one shared inbox in a single week, and an invite link is a bearer credential.
  for (const e of ['video@thestandard.co', 'sound@thestandard.co', 'EVENT@thestandard.co']) {
    assert.equal(isInvitableEmail(e), false, `${e} should not be invited`)
  }
  assert.equal(isInvitableEmail('chaiyaphat.t@thestandard.co'), true)
})

test('addresses outside the org are not invited', () => {
  assert.equal(isInvitableEmail('boriphat.yao@gmail.com'), false)
  assert.equal(isInvitableEmail('someone@thestandard.co.evil.com'), false)
  assert.equal(isInvitableEmail('someone@sub.thestandard.co'), false)
  // Case and stray whitespace must not be a way past either rule.
  assert.equal(isInvitableEmail('  Tanapak.I@THESTANDARD.CO '), true)
})

test('malformed addresses are refused rather than mailed', () => {
  for (const e of ['', '   ', 'nope', '@thestandard.co', 'someone@', 'a@b@thestandard.co']) {
    assert.equal(isInvitableEmail(e), false, `${e || '(empty)'} should not be invited`)
  }
})

test('both lists are env-overridable, and junk falls back to the safe default', () => {
  const savedEx = process.env.REVIEW_EXCLUDE_EMAILS
  const savedDom = process.env.REVIEW_ALLOWED_EMAIL_DOMAINS
  delete process.env.REVIEW_EXCLUDE_EMAILS
  delete process.env.REVIEW_ALLOWED_EMAIL_DOMAINS
  assert.ok(reviewExcludedEmails().includes('video@thestandard.co'))
  assert.deepEqual(reviewAllowedDomains(), ['thestandard.co'])

  process.env.REVIEW_EXCLUDE_EMAILS = 'bickboon@thestandard.co'
  assert.deepEqual(reviewExcludedEmails(), ['bickboon@thestandard.co'])
  assert.equal(isInvitableEmail('video@thestandard.co'), true, 'an explicit list REPLACES the default')

  // Junk that parses to nothing must not silently open the gate…
  process.env.REVIEW_EXCLUDE_EMAILS = ' , , '
  assert.ok(reviewExcludedEmails().includes('video@thestandard.co'))
  // …but an explicit empty string is a real choice: exclude nobody.
  process.env.REVIEW_EXCLUDE_EMAILS = ''
  assert.deepEqual(reviewExcludedEmails(), [])

  process.env.REVIEW_ALLOWED_EMAIL_DOMAINS = '@thestandard.co, partner.co.th'
  assert.deepEqual(reviewAllowedDomains(), ['thestandard.co', 'partner.co.th'])

  if (savedEx === undefined) delete process.env.REVIEW_EXCLUDE_EMAILS
  else process.env.REVIEW_EXCLUDE_EMAILS = savedEx
  if (savedDom === undefined) delete process.env.REVIEW_ALLOWED_EMAIL_DOMAINS
  else process.env.REVIEW_ALLOWED_EMAIL_DOMAINS = savedDom
})

test('excluding a mailbox drops it from the ASK list without erasing its team', () => {
  // The camera team worked the shoot even when the only camera entry is video@.
  // If exclusion also removed the team, the producer would be asked to rate
  // nobody and the booking would go unsurveyed — the opposite of the intent.
  const invites = buildInvites({
    ...base,
    assignedEmails: ['video@thestandard.co', 'snd@thestandard.co'],
    mainVideographerEmail: 'video@thestandard.co',
  }, roster)
  assert.equal(invites.some(i => i.email === 'video@thestandard.co'), false)
  const pd = invites.find(i => i.email === 'pd@thestandard.co')!
  assert.ok(pd, 'the producer is still invited')
  assert.ok(pd.targets.includes('camera'), 'the camera team is still rateable')
  const snd = invites.find(i => i.email === 'snd@thestandard.co')!
  assert.ok(snd.targets.includes('camera'))
})

// ── v1.173.2 — two voices: the side that USED the service vs the side that gave it

const mailArgs = {
  what: 'Long Form · EP1',
  shootDateTh: '5 ส.ค. 2026',
  bookingCode: 'AGN-260805-01',
  url: 'https://probook.xtec9.xyz/review/tok',
}

test('the producer side is thanked for USING Probook and asked to rate the crew teams', () => {
  const m = buildInviteMail({ ...mailArgs, raterRole: 'producer', targets: ['camera', 'sound'] })
  assert.match(m.text, /ขอบคุณสำหรับการใช้งาน Probook/)
  assert.match(m.text, /ขอรบกวนให้คะแนนทีมช่างภาพ และทีมเสียงครับ/)
  assert.ok(m.text.includes(OVERALL_TH), 'the producer side rates a SERVICE')
  assert.ok(!m.text.includes('การทำงานหนัก'))
})

test('the crew is thanked for the WORK and asked whether the day went smoothly', () => {
  const m = buildInviteMail({ ...mailArgs, raterRole: 'camera', targets: ['producer', 'sound'] })
  assert.match(m.text, /ขอบคุณสำหรับการทำงานหนัก/)
  assert.match(m.text, /การทำงานกับทีมและโปรดิวเซอร์ในงานนี้ราบรื่นไหมครับ\?/)
  assert.ok(m.text.includes(OVERALL_TH_CREW), 'the crew rates the JOB, not a service they bought')
  assert.ok(!m.text.includes('การใช้งาน Probook'))
})

test('"คนอื่นๆ" reads the producer-side letter, not the crew one', () => {
  // classifyRater buckets anyone it cannot place as 'other' — a coordinator or a
  // guest on set. They are on the receiving end of the service, so they get the
  // same letter as the producer.
  const m = buildInviteMail({ ...mailArgs, raterRole: 'other', targets: ['camera'] })
  assert.match(m.text, /ขอบคุณสำหรับการใช้งาน Probook/)
  assert.equal(isCrewRole('other'), false)
  assert.equal(overallLabelFor('other'), OVERALL_TH)
  assert.equal(overallLabelFor('sound'), OVERALL_TH_CREW)
})

test('the producer-side ask names only the teams that actually worked the shoot', () => {
  // A shoot with no sound team must not ask its producer to rate ทีมเสียง.
  const m = buildInviteMail({ ...mailArgs, raterRole: 'producer', targets: ['camera'] })
  assert.match(m.text, /ขอรบกวนให้คะแนนทีมช่างภาพครับ/)
  assert.ok(!m.text.includes('ทีมเสียง'))
})

test('both letters carry the job, the date, the link and the confidentiality line', () => {
  for (const role of ['producer', 'camera', 'sound', 'other']) {
    const m = buildInviteMail({ ...mailArgs, raterRole: role, targets: ['camera'] })
    assert.ok(m.text.includes('Long Form · EP1'), `${role}: job name`)
    assert.ok(m.text.includes('5 ส.ค. 2026'), `${role}: shoot date`)
    assert.ok(m.text.includes('AGN-260805-01'), `${role}: production id`)
    assert.ok(m.text.includes(mailArgs.url), `${role}: form link`)
    assert.ok(m.text.includes(MAIL_CONFIDENTIAL_TH), `${role}: confidentiality line`)
    assert.equal(m.subject, '[ประเมินงาน] AGN-260805-01 Long Form · EP1')
    // The catch-up window means this can land days later — no copy may claim
    // the shoot was today or yesterday.
    assert.ok(!/เมื่อวาน|วันนี้/.test(m.text), `${role}: must not name a relative day`)
  }
})

test('junk target roles are still refused', () => {
  assert.equal(isSubmittableTarget('everyone'), false)
  assert.equal(isSubmittableTarget(''), false)
  assert.equal(isSubmittableTarget(null), false)
})
