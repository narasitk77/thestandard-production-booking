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
 * and the operator named exactly who reads what. An admin who is not on the list
 * gets the same 403 as anyone else.
 *
 * `REVIEW_CONTENT_READER_EMAILS` / `REVIEW_ACTIVITY_READER_EMAILS`
 * (comma-separated) override the defaults without a code change — but each
 * REPLACES its list rather than extending it, so the set is always exactly what
 * one place says it is. Adding the operator back to content therefore takes a
 * deliberate env change, which is the guarantee the form's notice relies on.
 */

/**
 * v1.173.4 — TWO tiers, because this stopped being a quality survey and became
 * the channel for the things people will not say to someone's face.
 *
 * The operator's instruction: the managers read the messages; the operator —
 * who runs the system, sits on the crew list, and is often the producer being
 * rated — sees only THAT a job produced feedback. A system owner who can read
 * every complaint about himself is a system nobody complains in.
 *
 *   content  → the messages, the scores, the names. Managers only.
 *   activity → did it go out, did anyone answer, is anything stuck. No content.
 *
 * Both lists fail CLOSED: an env var set to junk falls back to these defaults
 * rather than to "everybody", and an unknown email gets nothing.
 */
const DEFAULT_CONTENT_READERS = [
  'panu.w@thestandard.co',      // ปุ๊ก
  'chonlathorn.j@thestandard.co', // หวาน
]

/** Sees the pipeline, never the words. */
const DEFAULT_ACTIVITY_READERS = [
  'narasit.k@thestandard.co',   // นัท — operator
]

function parseList(raw: string | undefined, fallback: string[]): string[] {
  const v = raw?.trim()
  if (!v) return fallback
  const list = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.length > 0 ? list : fallback
}

/** Who may read the messages, the scores and the raters' names. */
export function reviewContentReaderEmails(): string[] {
  return parseList(process.env.REVIEW_CONTENT_READER_EMAILS, DEFAULT_CONTENT_READERS)
}

/** Who may see only that feedback exists, on top of the content readers. */
export function reviewActivityReaderEmails(): string[] {
  return parseList(process.env.REVIEW_ACTIVITY_READER_EMAILS, DEFAULT_ACTIVITY_READERS)
}

/**
 * The ONLY predicate that may gate review CONTENT — messages, scores, names.
 * Called on the server in every route that can return any of it; hiding a menu
 * item is not access control.
 */
export function canReadReviewContent(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase()
  if (!e) return false
  return reviewContentReaderEmails().includes(e)
}

/**
 * May see the pipeline: which jobs produced feedback, how many answered, what is
 * stuck. Content readers necessarily qualify — they see strictly more.
 */
export function canSeeReviewActivity(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase()
  if (!e) return false
  return canReadReviewContent(e) || reviewActivityReaderEmails().includes(e)
}

/**
 * How the readers are named in every user-facing sentence. One constant, because
 * six different places used to spell out "3 คน (นัท · ปุ๊ก · หวาน)" and a change of
 * audience has to move all of them or the app lies in whichever one was missed.
 */
export const CONTENT_READERS_TH = 'หัวหน้าทีม 2 คน (ปุ๊ก · หวาน)'

/**
 * What a rater is told on the form. Kept next to the gate on purpose: if the
 * audience for reviews ever changes, the sentence people read has to move with
 * it, or the app starts lying to its own staff.
 *
 * v1.173.4 — it used to promise "ผู้ดูแลระบบ 3 คน (นัท · ปุ๊ก · หวาน)". The moment
 * the operator stopped reading the messages, that sentence became false in BOTH
 * directions: it named a reader who no longer reads, and it described managers as
 * system admins. The second clause is the operator's own commitment written down
 * where the staff can hold him to it.
 */
export const ANONYMITY_NOTICE_TH =
  'คำตอบของคุณจะไม่ถูกเปิดเผยต่อผู้ถูกประเมินหรือเพื่อนร่วมงาน — ' +
  `ผู้อ่านข้อความคือ${CONTENT_READERS_TH} เท่านั้น ` +
  'ผู้ดูแลระบบเห็นเพียงว่ามีการส่ง ไม่เห็นข้อความ เพื่อใช้ปรับปรุงการทำงาน'

/** Roles that can be rated, and the Thai label used in the form + reports. */
export const REVIEW_TARGET_ROLES = [
  { key: 'producer', th: 'ทีมโปรดิวเซอร์ / เจ้าของงาน' },
  { key: 'camera', th: 'ทีมกล้อง' },
  { key: 'sound', th: 'ทีมเสียง' },
] as const

/**
 * How the teams are named in the invite MAIL — the operator's wording, which is
 * shorter than the form's headings ("ทีมช่างภาพ" rather than "ทีมกล้อง") because
 * it has to read as a sentence: "ขอรบกวนให้คะแนนทีมช่างภาพ และทีมเสียงครับ".
 * Kept beside the canonical list so the two cannot drift out of sync silently.
 */
export const REVIEW_TARGET_MAIL_TH: Record<string, string> = {
  producer: 'ทีมโปรดิวเซอร์',
  camera: 'ทีมช่างภาพ',
  sound: 'ทีมเสียง',
}

/**
 * The confidentiality line in the MAIL. The form keeps the longer
 * ANONYMITY_NOTICE_TH (which names who can actually read the answers):
 * the promise has to be spelled out where someone is about to answer, not
 * shortened there.
 */
export const MAIL_CONFIDENTIAL_TH = '(ข้อความจะถูกเก็บเป็นความลับ ไม่เผยแพร่ให้ผู้ร่วมงานรับรู้)'

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

/**
 * v1.173.2 — the same question, asked in the recipient's own terms.
 *
 * The producer's side is asking about a SERVICE they received; the crew is
 * asking about a JOB they worked. One sentence cannot be both without sounding
 * like it was written for someone else, which is how a survey gets ignored.
 * Same stored row either way (`targetRole: 'overall'`) — only the wording moves,
 * so the number stays comparable across the whole team.
 */
export const OVERALL_TH_CREW = 'ความพึงพอใจโดยรวมต่อการทำงานนี้'

/** camera/sound = the people delivering the service. producer/other = receiving it. */
export function isCrewRole(raterRole: string | null | undefined): boolean {
  const r = (raterRole || '').trim().toLowerCase()
  return r === 'camera' || r === 'sound'
}

export function overallLabelFor(raterRole: string | null | undefined): string {
  return isCrewRole(raterRole) ? OVERALL_TH_CREW : OVERALL_TH
}

/**
 * What the free-text box under the overall question invites. For the crew this is
 * now the ONLY place a problem with another team can land, so the box has to say
 * so — otherwise the star rows read as "nobody asked about that" and the thing
 * they actually wanted to raise goes unsaid.
 */
export function overallHintFor(raterRole: string | null | undefined): string {
  return isCrewRole(raterRole)
    ? 'อะไรที่ควรทำต่อ / อะไรที่ควรแก้ · มีเรื่องของทีมอื่นในกองก็เขียนมาได้เลยครับ (ไม่บังคับ)'
    : 'อะไรที่ควรทำต่อ / อะไรที่ควรแก้ บอกได้เลยครับ (ไม่บังคับ)'
}

export function isOverallTarget(v: unknown): boolean {
  return v === OVERALL_TARGET
}

/** Every targetRole a submitted form may legitimately carry. */
export function isSubmittableTarget(v: unknown): boolean {
  return isReviewTargetRole(v) || isOverallTarget(v)
}

/**
 * Who this rater is asked to score.
 *
 * v1.173.8 — the crew no longer scores the crew. Camera and sound work side by
 * side all day; putting a star rating on each other turned a service survey into
 * a scoreboard between colleagues who have to share a van tomorrow, and neither
 * team receives anything from the other to judge. They score the producer side,
 * which is the service they actually receive, plus the job overall — and anything
 * they need to say about another team goes in the free-text box, where it reads
 * as a sentence a manager can act on rather than a number nobody can explain.
 *
 * The producer side still scores every crew team: they DO receive that work.
 * 'other' (a coordinator, a guest on set) is on the receiving side too.
 */
export function targetsFor(raterRole: string, presentRoles: ReviewTargetRole[]): ReviewTargetRole[] {
  const mine = (raterRole || '').trim().toLowerCase()
  if (isCrewRole(mine)) return presentRoles.filter(r => r === 'producer')
  return presentRoles.filter(r => r !== mine)
}

/** 1–5, integer. Anything else is a bad request, not a silently clamped value. */
export function isValidScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5
}
