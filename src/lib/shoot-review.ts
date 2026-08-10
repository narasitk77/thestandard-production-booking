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
import { REVIEW_TARGET_ROLES, targetsFor } from './review-access'

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
export function buildInvites(
  booking: BookingForReview,
  rosterRoleByEmail: Record<string, string>,
): ReviewInvitee[] {
  if (booking.deletedAt || booking.status === 'CANCELLED') return []

  const emails = new Set<string>()
  for (const e of booking.assignedEmails || []) if (e?.trim()) emails.add(e.trim().toLowerCase())
  if (booking.mainVideographerEmail?.trim()) emails.add(booking.mainVideographerEmail.trim().toLowerCase())
  if (booking.producerEmail?.trim()) emails.add(booking.producerEmail.trim().toLowerCase())
  // NOTE: `createdByEmail` is deliberately NOT invited on its own. Coordinators
  // and admins file bookings for other people all the time and never go on set;
  // asking them to rate a shoot they did not attend produces noise, and asking
  // the whole company for ratings is how a survey loses its credibility. They
  // are included only when they are also the producer or on the crew.
  if (emails.size === 0) return []

  const roleByEmail = new Map<string, string>()
  for (const e of Array.from(emails)) roleByEmail.set(e, classifyRater(e, booking, rosterRoleByEmail))

  const present = presentRoles(booking, Array.from(roleByEmail.values()))
  // Fewer than two teams present → everyone would be rating nobody.
  if (present.length < 2) return []

  const out: ReviewInvitee[] = []
  for (const [email, role] of Array.from(roleByEmail)) {
    const targets = targetsFor(role, present)
    if (targets.length === 0) continue
    out.push({ email, role, targets })
  }
  return out
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
