/**
 * v1.166 — who may read post-shoot peer reviews.
 *
 * The promise made to crew on the form is: *the people you rate, and every
 * other colleague, never see who said what.* That promise is only as good as
 * this gate, so it lives in one tiny module with its own tests and is called on
 * the SERVER in every route that can return review content. Hiding a menu item
 * is not access control.
 *
 * Deliberately NOT tied to `role === 'ADMIN'`: the console has several admins
 * and the operator named exactly three people. An admin who is not on the list
 * gets the same 403 as anyone else.
 *
 * `REVIEW_OWNER_EMAILS` (comma-separated) overrides the default without a code
 * change — but it REPLACES the list rather than extending it, so the set is
 * always exactly what one place says it is.
 */

const DEFAULT_OWNERS = [
  'narasit.k@thestandard.co',
  'panu.w@thestandard.co',
  'chonlathorn.j@thestandard.co',
]

export function reviewOwnerEmails(): string[] {
  const raw = process.env.REVIEW_OWNER_EMAILS?.trim()
  const list = raw
    ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_OWNERS
  // An env var set to junk (e.g. just commas) must not silently open the door
  // to nobody-checks-anything; fall back to the named three.
  return list.length > 0 ? list : DEFAULT_OWNERS
}

/** The ONLY predicate that may gate review content. */
export function canReadReviews(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase()
  if (!e) return false
  return reviewOwnerEmails().includes(e)
}

/**
 * What a rater is told on the form. Kept next to the gate on purpose: if the
 * audience for reviews ever widens, the sentence people read has to move with
 * it, or the app starts lying to its own staff.
 */
export const ANONYMITY_NOTICE_TH =
  'คำตอบของคุณจะไม่ถูกเปิดเผยต่อผู้ถูกประเมินหรือเพื่อนร่วมงาน — ' +
  'มีเพียงผู้ดูแลระบบ 3 คน (นัท · ปุ๊ก · หวาน) ที่เห็นได้ เพื่อใช้ปรับปรุงการทำงาน'

/** Roles that can be rated, and the Thai label used in the form + reports. */
export const REVIEW_TARGET_ROLES = [
  { key: 'producer', th: 'ทีมโปรดิวเซอร์ / เจ้าของงาน' },
  { key: 'camera', th: 'ทีมกล้อง' },
  { key: 'sound', th: 'ทีมเสียง' },
] as const

export type ReviewTargetRole = (typeof REVIEW_TARGET_ROLES)[number]['key']

export function isReviewTargetRole(v: unknown): v is ReviewTargetRole {
  return typeof v === 'string' && REVIEW_TARGET_ROLES.some(r => r.key === v)
}

/**
 * v1.173 — one question asked of EVERYONE, about the job as a whole instead of a
 * team: how satisfied were you with how this shoot was served? That is the
 * number the operator actually reports on ("ข้อมูลการให้บริการ"); a per-team
 * average answers a different question.
 *
 * Stored as a normal ShootReview row with targetRole 'overall', so it exports,
 * ages, and stays append-only with everything else, and the existing unique
 * index on (bookingId, raterEmail, targetRole) already limits it to one per
 * person per booking. No migration.
 *
 * Deliberately NOT a member of REVIEW_TARGET_ROLES: that list drives the mutual
 * rule (rate every team but your own). 'overall' is not a team — inside that
 * list, `targetsFor` would hand it out or withhold it depending on the rater's
 * own role, so the producer would be asked for overall satisfaction and the
 * producer's own team would not.
 */
export const OVERALL_TARGET = 'overall'
export const OVERALL_TH = 'ความพึงพอใจโดยรวมต่อการให้บริการงานนี้'

export function isOverallTarget(v: unknown): boolean {
  return v === OVERALL_TARGET
}

/** Every targetRole a submitted form may legitimately carry. */
export function isSubmittableTarget(v: unknown): boolean {
  return isReviewTargetRole(v) || isOverallTarget(v)
}

/**
 * Mutual review: you rate every team on the shoot EXCEPT your own. Returns the
 * teams this rater is asked about, given which teams actually worked the job.
 */
export function targetsFor(raterRole: string, presentRoles: ReviewTargetRole[]): ReviewTargetRole[] {
  const mine = (raterRole || '').trim().toLowerCase()
  return presentRoles.filter(r => r !== mine)
}

/** 1–5, integer. Anything else is a bad request, not a silently clamped value. */
export function isValidScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5
}
