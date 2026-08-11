/**
 * v1.166 — post-shoot peer review: who gets asked, about whom, and how the
 * invite link is minted.
 *
 * One day after a shoot, everyone who worked it is invited to rate the OTHER
 * teams. Mutual by design (operator directive): the outlet/producer side rates
 * camera and sound, and camera and sound rate the producer side back — a
 * one-way form would read as management grading crew, which is not the point.
 *
 * The invite is a TOKEN link, not a login: crew read email on a phone and half
 * of them are freelancers without a session. The token is single-purpose (it
 * identifies one person on one booking and nothing else), long, and its
 * submission is idempotent — the unique index on (bookingId, raterEmail,
 * targetRole) is the real guard, not the token.
 *
 * Everything here is pure except `buildInvites`, which only READS the booking.
 */
import { randomBytes, createHash } from 'crypto'
import type { ReviewTargetRole } from './review-access'
import {
  REVIEW_TARGET_ROLES, targetsFor, REVIEW_TARGET_MAIL_TH,
  MAIL_CONFIDENTIAL_TH, isCrewRole, overallLabelFor, OVERALL_TARGET, CONTENT_READERS_TH,
} from './review-access'

export function reviewsEnabled(): boolean {
  return process.env.SHOOT_REVIEW_ENABLED?.trim() === '1'
}

/** Days after the shoot date to send the form. Operator chose 1. */
export function reviewDelayDays(): number {
  const n = Number(process.env.SHOOT_REVIEW_DELAY_DAYS ?? 1)
  return Number.isFinite(n) && n >= 0 ? n : 1
}

/**
 * v1.173 — how far back to keep looking for finished jobs nobody was asked
 * about.
 *
 * The first cut matched ONE calendar day exactly (`shootEndDate: target`), so
 * any morning the sender did not run — a deploy, a container restart, a DB blip
 * — skipped that day's shoots permanently. There was no second chance and
 * nothing to show that a day had been missed.
 */
export function reviewLookbackDays(): number {
  const n = Number(process.env.SHOOT_REVIEW_LOOKBACK_DAYS ?? 7)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7
}

/**
 * Most bookings one run will survey. Oldest first, so a backlog drains over a
 * few days instead of arriving as one mass mailing — which is what the very
 * first run after switching the feature on would otherwise be.
 */
export function reviewMaxBookingsPerRun(): number {
  const n = Number(process.env.SHOOT_REVIEW_MAX_BOOKINGS ?? 20)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20
}

/**
 * The band of LAST-shoot-days a run acts on: finished at least `delayDays` ago,
 * and no earlier than `lookbackDays` before that. BOTH BOUNDS INCLUSIVE.
 *
 * `todayBkk` must be Bangkok midnight expressed as a UTC Date (see
 * startOfTodayBangkok) — Prisma stores @db.Date as UTC midnight, and the worker
 * fires at 10:00 BKK = 03:00 UTC, so UTC arithmetic on a UTC `now` points at
 * the wrong calendar day.
 */
export function dueWindow(
  todayBkk: Date,
  delayDays: number,
  lookbackDays: number,
): { from: Date; to: Date } {
  const to = new Date(todayBkk)
  to.setUTCDate(to.getUTCDate() - delayDays)
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - lookbackDays)
  return { from, to }
}

/** 32 random bytes, url-safe. Long enough that guessing is not a threat model. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Stable short id for a token, safe to put in logs/audit rows. The token itself
 * must never appear in a log — it is a bearer credential for one person's form.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/**
 * v1.173 — who may HOLD an invite. Two rules, both from the operator after
 * reading a real dry run:
 *
 * 1. **Shared team mailboxes are not people.** `video@` and `sound@` sit in
 *    assignedEmails as a stand-in for "the camera team" / "the sound team" —
 *    264 and 205 times across the last 300 bookings — so one week's batch was
 *    about to send video@ eighteen separate invites. Worse, an invite link is a
 *    bearer credential: anyone with the shared inbox could file ratings on
 *    behalf of the team, which makes both the numbers and the promise of
 *    "nobody sees who said what" meaningless.
 * 2. **Only @thestandard.co.** An outside address must not hold a link that
 *    rates staff.
 *
 * Env-overridable, because which addresses are shared is an org fact and not a
 * code fact — but the DEFAULTS are the shared boxes actually present in the
 * data, so correct behaviour does not depend on anyone remembering to set a var.
 */
const DEFAULT_EXCLUDED_EMAILS = [
  'video@thestandard.co',
  'sound@thestandard.co',
  'event@thestandard.co',
]

export function reviewExcludedEmails(): string[] {
  const raw = process.env.REVIEW_EXCLUDE_EMAILS?.trim()
  if (raw === undefined) return DEFAULT_EXCLUDED_EMAILS
  // An explicit empty string means "exclude nobody" — a deliberate choice the
  // operator can make. Junk that parses to nothing falls back to the defaults.
  if (raw === '') return []
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_EXCLUDED_EMAILS
}

export function reviewAllowedDomains(): string[] {
  const raw = process.env.REVIEW_ALLOWED_EMAIL_DOMAINS?.trim()
  if (!raw) return ['thestandard.co']
  const list = raw.split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  return list.length > 0 ? list : ['thestandard.co']
}

/** Pure so both rules are pinned by tests rather than by whoever reads the env. */
export function isInvitableEmail(
  email: string,
  excluded: string[] = reviewExcludedEmails(),
  domains: string[] = reviewAllowedDomains(),
): boolean {
  const e = (email || '').trim().toLowerCase()
  // Exactly one '@'. Splitting on the LAST one let `a@b@thestandard.co` read as
  // internal — a malformed address must fail the domain rule, not slip through
  // it, since passing the rule is what hands someone a link to rate staff.
  const parts = e.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  if (excluded.includes(e)) return false
  return domains.includes(parts[1])
}

export interface BookingForReview {
  id: string
  bookingCode: string | null
  shootDate: Date
  status: string
  deletedAt: Date | null
  producerEmail: string | null
  createdByEmail: string | null
  assignedEmails: string[]
  mainVideographerEmail: string | null
  crewRequired: string[]
}

export interface ReviewInvitee {
  email: string
  /** The invitee's OWN role on this shoot — decides which teams they rate. */
  role: string
  targets: ReviewTargetRole[]
}

/**
 * Which team an assigned person belongs to, from the crew roster's role map.
 * `rosterRoleByEmail` is supplied by the caller (it reads the DB/roster), so
 * this stays pure and testable.
 */
export function classifyRater(
  email: string,
  booking: { producerEmail: string | null; createdByEmail: string | null; mainVideographerEmail: string | null },
  rosterRoleByEmail: Record<string, string>,
): string {
  const e = email.trim().toLowerCase()
  if (e === (booking.producerEmail || '').toLowerCase()) return 'producer'
  if (e === (booking.createdByEmail || '').toLowerCase()) return 'producer'
  if (e === (booking.mainVideographerEmail || '').toLowerCase()) return 'camera'
  const roster = (rosterRoleByEmail[e] || '').toLowerCase()
  if (roster === 'sound') return 'sound'
  if (roster === 'video' || roster === 'photo' || roster === 'switcher' || roster === 'director') return 'camera'
  if (roster === 'producer') return 'producer'
  return 'other'
}

/** Which teams actually worked this shoot — you cannot rate a team that wasn't there. */
export function presentRoles(
  booking: { crewRequired: string[]; producerEmail: string | null; createdByEmail: string | null },
  raterRoles: string[],
): ReviewTargetRole[] {
  const present = new Set<ReviewTargetRole>()
  if (booking.producerEmail || booking.createdByEmail) present.add('producer')
  if (raterRoles.includes('camera')) present.add('camera')
  if (raterRoles.includes('sound') || (booking.crewRequired || []).includes('Sound')) present.add('sound')
  // Keep the canonical order so the form reads the same every time.
  return REVIEW_TARGET_ROLES.map(r => r.key).filter(k => present.has(k))
}

/**
 * Build the invite list for one booking. Returns [] when the shoot has nobody
 * to ask or only ONE team — a form with no other team to rate is noise.
 */
/**
 * Everyone on the booking who could conceivably be asked, before the
 * invitability rules. Shared so the "who got skipped" report cannot drift from
 * the list buildInvites actually works from.
 *
 * NOTE: `createdByEmail` is deliberately absent. Coordinators and admins file
 * bookings for other people all the time and never go on set; asking them to
 * rate a shoot they did not attend produces noise, and asking the whole company
 * for ratings is how a survey loses its credibility. They are included only when
 * they are also the producer or on the crew.
 */
export function crewEmails(booking: BookingForReview): string[] {
  const emails = new Set<string>()
  for (const e of booking.assignedEmails || []) if (e?.trim()) emails.add(e.trim().toLowerCase())
  if (booking.mainVideographerEmail?.trim()) emails.add(booking.mainVideographerEmail.trim().toLowerCase())
  if (booking.producerEmail?.trim()) emails.add(booking.producerEmail.trim().toLowerCase())
  return Array.from(emails)
}

/** On the booking but not mailable — reported so a filtered-out crowd is visible. */
export function nonInvitableEmails(booking: BookingForReview): string[] {
  const excluded = reviewExcludedEmails()
  const domains = reviewAllowedDomains()
  return crewEmails(booking).filter(e => !isInvitableEmail(e, excluded, domains))
}

export function buildInvites(
  booking: BookingForReview,
  rosterRoleByEmail: Record<string, string>,
): ReviewInvitee[] {
  if (booking.deletedAt || booking.status === 'CANCELLED') return []

  const emails = new Set<string>(crewEmails(booking))
  if (emails.size === 0) return []

  const roleByEmail = new Map<string, string>()
  for (const e of Array.from(emails)) roleByEmail.set(e, classifyRater(e, booking, rosterRoleByEmail))

  // Which teams are RATEABLE is decided from everyone on the booking, including
  // the addresses nobody can be mailed at: a shared video@ entry still means the
  // camera team worked this shoot, and "ทีมกล้อง" is a team, not that mailbox. So
  // the exclusion below drops people from the ASK list only — it must not quietly
  // erase a team from the questions everyone else answers.
  const present = presentRoles(booking, Array.from(roleByEmail.values()))
  // Fewer than two teams present → everyone would be rating nobody.
  if (present.length < 2) return []

  const excluded = reviewExcludedEmails()
  const domains = reviewAllowedDomains()

  const out: ReviewInvitee[] = []
  for (const [email, role] of Array.from(roleByEmail)) {
    if (!isInvitableEmail(email, excluded, domains)) continue
    const targets = targetsFor(role, present)
    if (targets.length === 0) continue
    out.push({ email, role, targets })
  }
  return out
}

/**
 * v1.173.2 — the invite mail, in TWO voices (operator's copy).
 *
 * The producer's side used Probook to get a crew and is being asked to rate the
 * service; the crew did the work and is being asked whether the day went
 * smoothly. Addressing both with one paragraph made half the recipients read a
 * letter written for somebody else.
 *
 * Pure, and the ONLY place either body exists — the dry-run sample the operator
 * reads before switching the feature on is built by this same function, so what
 * they approve is what the team receives.
 */
export function buildInviteMail(input: {
  what: string
  shootDateTh: string
  bookingCode: string | null
  /** The RECIPIENT's own role: producer | camera | sound | other. */
  raterRole: string
  /** Teams this person is asked about, decided by buildInvites. */
  targets: string[]
  url: string
}): { subject: string; text: string } {
  const { what, shootDateTh, bookingCode, raterRole, targets, url } = input
  const crew = isCrewRole(raterRole)
  // " และ" with no trailing space — Thai does not space after และ, and the
  // operator's copy reads "ทีมช่างภาพ และทีมเสียงครับ".
  const teamList = targets.map(t => REVIEW_TARGET_MAIL_TH[t] || t).join(' และ')

  const head = crew
    ? `ขอบคุณสำหรับการทำงานหนัก — ${what} (${shootDateTh}) ครับ 🙏`
    : `ขอบคุณสำหรับการใช้งาน Probook — ${what} (${shootDateTh}) ครับ 🙏`

  // "วันนี้" is deliberately not used: with the catch-up window this mail can
  // arrive a few days after the shoot, and copy that names the wrong day is the
  // first thing that makes a survey feel like it was sent by a machine that was
  // not paying attention. Same reason the old greeting stopped saying "เมื่อวาน".
  const ask = crew
    ? 'การทำงานกับทีมและโปรดิวเซอร์ในงานนี้ราบรื่นไหมครับ?'
    : `ขอรบกวนให้คะแนน${teamList}ครับ`

  return {
    subject: `[ประเมินงาน] ${bookingCode || ''} ${what}`.trim(),
    text: [
      head,
      '',
      `งาน: ${what}`,
      `Production ID: ${bookingCode || '—'}`,
      `วันถ่าย: ${shootDateTh}`,
      '',
      ask,
      `พร้อม${overallLabelFor(raterRole)} สัก 1 นาที`,
      '',
      url,
      '',
      MAIL_CONFIDENTIAL_TH,
      '',
      'THE STANDARD Production Booking',
    ].join('\n'),
  }
}

/**
 * v1.173.3 — the receipt, sent to the person who just answered.
 *
 * Without it the loop is open: you fill in a form, a thank-you screen flashes,
 * and nothing you can point to ever confirms it arrived. Anyone who wrote
 * something that mattered to them then has exactly one way to find out whether it
 * landed — walk over and ask the operator "เห็นที่ผมเขียนไหม". This mail is the
 * answer to that question, arriving before it gets asked.
 *
 * It echoes the person's OWN answers back, which is safe: it goes to their own
 * address. Their answers are deliberately NOT readable from the form link —
 * that token is a bearer credential and a forwarded mail would hand someone
 * else's ratings to whoever opened it.
 */
export function buildReceiptMail(input: {
  what: string
  bookingCode: string | null
  submittedAtTh: string
  raterRole: string
  rows: Array<{ targetRole: string; score: number; comment: string | null }>
}): { subject: string; text: string } {
  const { what, bookingCode, submittedAtTh, raterRole, rows } = input

  const label = (t: string) =>
    t === OVERALL_TARGET ? overallLabelFor(raterRole) : (REVIEW_TARGET_MAIL_TH[t] || t)
  // Stars, because "4" alone reads like a grade out of nothing.
  const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n))

  const answered = rows.map(r => `  · ${label(r.targetRole)}: ${stars(r.score)} (${r.score}/5)`)
  const comments = rows
    .filter(r => r.comment)
    .map(r => `  · ${label(r.targetRole)} — “${r.comment}”`)

  return {
    subject: `[ประเมินงาน] ได้รับคำตอบของคุณแล้ว — ${bookingCode || what}`,
    text: [
      'ได้รับคำตอบของคุณแล้วครับ ขอบคุณที่สละเวลา 🙏',
      '',
      `งาน: ${what}`,
      `Production ID: ${bookingCode || '—'}`,
      `ส่งเมื่อ: ${submittedAtTh}`,
      '',
      'คะแนนที่คุณส่ง',
      ...answered,
      ...(comments.length ? ['', 'ข้อความที่คุณเขียน', ...comments] : []),
      '',
      // Deliberately no promise of a reply to every message — a commitment the
      // team cannot keep would bring back the same follow-up it is meant to end.
      `คำตอบนี้ถูกบันทึกไว้แล้วและแก้ไขไม่ได้ · ผู้อ่านคือ${CONTENT_READERS_TH} เท่านั้น`,
      'ถ้ามีเรื่องที่ต้องแก้ ทีมจะติดต่อกลับ — เมลฉบับนี้ใช้เป็นหลักฐานว่าส่งถึงแล้ว ไม่ต้องตามถามครับ',
      '',
      'THE STANDARD Production Booking',
    ].join('\n'),
  }
}

/** The criteria shown on the form. Kept small on purpose — a long form on a
 *  phone after a shoot day gets abandoned. */
export const REVIEW_CRITERIA = [
  { key: 'communication', th: 'การสื่อสาร / ประสานงาน' },
  { key: 'onTime', th: 'ตรงเวลา / ความพร้อม' },
  { key: 'quality', th: 'คุณภาพงานที่ส่งมอบ' },
] as const

export type ReviewCriterionKey = (typeof REVIEW_CRITERIA)[number]['key']

export function isCriterionKey(v: unknown): v is ReviewCriterionKey {
  return typeof v === 'string' && REVIEW_CRITERIA.some(c => c.key === v)
}

/**
 * v1.173.7 — which criteria a given RATER is asked, which is not the same for
 * everyone on the shoot.
 *
 * "คุณภาพงานที่ส่งมอบ" only means something to the side that RECEIVES delivered
 * work. Camera and sound hand nothing to each other and receive no deliverable
 * from the producer, so asking them to score it produced a number about nothing —
 * and it was dragging their derived per-team score with it. Operator's call, and
 * it keys off the rater rather than the target: the same camera team is asked
 * about delivery by a producer and not asked by the sound engineer.
 */
export function criteriaFor(raterRole: string | null | undefined) {
  return isCrewRole(raterRole)
    ? REVIEW_CRITERIA.filter(c => c.key !== 'quality')
    : REVIEW_CRITERIA.slice()
}

/** Server-side guard: a rater may only submit the criteria they were asked. */
export function isCriterionAllowedFor(raterRole: string | null | undefined, key: unknown): boolean {
  return isCriterionKey(key) && criteriaFor(raterRole).some(c => c.key === key)
}
