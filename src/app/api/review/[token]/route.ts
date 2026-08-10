/**
 * GET  /api/review/:token — what this person is being asked (no login needed)
 * POST /api/review/:token — submit their ratings
 *
 * The token identifies ONE person on ONE booking. It is a bearer credential, so:
 *   - it is never logged (only `tokenFingerprint`),
 *   - it grants nothing except this one form,
 *   - and it can NOT read anybody's answers back — not even the sender's own.
 *     Reviews leave through exactly one door: the owner-only report route.
 *
 * Submission is idempotent-ish by construction: the unique index on
 * (bookingId, raterEmail, targetRole) means a double-tap cannot create a second
 * rating, and an already-answered form says so instead of silently overwriting.
 * Nothing here updates or deletes an existing ShootReview — the operator asked
 * for an append-only record and this is the only writer.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import {
  isValidScore, isReviewTargetRole, REVIEW_TARGET_ROLES, ANONYMITY_NOTICE_TH, targetsFor,
  OVERALL_TARGET, isOverallTarget, isSubmittableTarget, overallLabelFor,
} from '@/lib/review-access'
import { REVIEW_CRITERIA, isCriterionKey, tokenFingerprint } from '@/lib/shoot-review'

export const dynamic = 'force-dynamic'

const ROLE_TH: Record<string, string> = Object.fromEntries(REVIEW_TARGET_ROLES.map(r => [r.key, r.th]))

async function loadInvite(token: string) {
  if (!token || token.length < 20) return null
  return prisma.shootReviewInvite.findUnique({
    where: { token },
    include: {
      booking: {
        select: {
          id: true, bookingCode: true, shootDate: true, deletedAt: true, status: true,
          crewRequired: true, producerEmail: true, createdByEmail: true,
          program: { select: { name: true } },
          outlet: { select: { name: true } },
          episodes: { orderBy: { sequence: 'asc' }, select: { title: true } },
        },
      },
    },
  })
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const invite = await loadInvite(params.token)
  if (!invite || invite.booking.deletedAt) {
    return NextResponse.json({ error: 'ลิงก์นี้ใช้ไม่ได้แล้ว' }, { status: 404 })
  }
  const already = await prisma.shootReview.findMany({
    where: { bookingId: invite.bookingId, raterEmail: invite.email },
    select: { targetRole: true },
  })
  const answered = new Set(already.map(a => a.targetRole))

  // v1.166.1 — the targets were decided ONCE, by buildInvites, when the invite
  // was minted, and the email named them. Recomputing here from this rater's
  // role alone produced a DIFFERENT set (presentRoles only ever saw one role,
  // so the camera team could never appear), i.e. the form asked something other
  // than what was promised. Read the stored list; fall back only for invites
  // minted before this column existed.
  const targets = (invite.targets?.length ? invite.targets : targetsFor(invite.role, REVIEW_TARGET_ROLES.map(r => r.key)))
    .filter(isReviewTargetRole)

  return NextResponse.json({
    booking: {
      code: invite.booking.bookingCode,
      shootDate: invite.booking.shootDate,
      show: invite.booking.program?.name || null,
      outlet: invite.booking.outlet?.name || null,
      job: invite.booking.episodes[0]?.title || null,
    },
    yourRole: invite.role,
    targets: targets.map(k => ({ key: k, th: ROLE_TH[k] || k, answered: answered.has(k) })),
    // v1.173 — asked of everyone, no matter which teams they were paired with,
    // so it is returned separately from `targets` rather than smuggled into it.
    // v1.173.2 — worded for whoever is holding the phone: the producer's side
    // rates a service, the crew rates a job. Same stored row; the form has to
    // match the sentence their invite mail used.
    overall: { key: OVERALL_TARGET, th: overallLabelFor(invite.role), answered: answered.has(OVERALL_TARGET) },
    criteria: REVIEW_CRITERIA,
    notice: ANONYMITY_NOTICE_TH,
    submittedAt: invite.submittedAt,
  })
}

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const invite = await loadInvite(params.token)
  if (!invite || invite.booking.deletedAt) {
    return NextResponse.json({ error: 'ลิงก์นี้ใช้ไม่ได้แล้ว' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({} as any))
  const raw = Array.isArray(body?.ratings) ? body.ratings : []
  if (raw.length === 0) return NextResponse.json({ error: 'ยังไม่ได้ให้คะแนน' }, { status: 400 })

  const allowed = (invite.targets || []).filter(isReviewTargetRole)
  const rows: Array<{ targetRole: string; score: number; scores: Record<string, number>; comment: string | null }> = []
  for (const r of raw) {
    if (!isSubmittableTarget(r?.targetRole)) {
      return NextResponse.json({ error: `ทีมปลายทางไม่ถูกต้อง: ${r?.targetRole}` }, { status: 400 })
    }
    // The team checks apply to TEAM rows only. 'overall' rates the job, not a
    // team, and every invitee is asked it — running it through the rules below
    // would reject it as "a team this form did not ask about".
    if (isReviewTargetRole(r.targetRole)) {
      if (r.targetRole === invite.role) {
        return NextResponse.json({ error: 'ประเมินทีมตัวเองไม่ได้' }, { status: 400 })
      }
      // Only the teams this invite actually asked about. Without this, a crafted
      // POST could file a permanent rating against a team that never worked the
      // shoot — and ratings cannot be deleted.
      if (allowed.length > 0 && !allowed.includes(r.targetRole)) {
        return NextResponse.json({ error: `แบบประเมินนี้ไม่ได้ถามถึง "${r.targetRole}"` }, { status: 400 })
      }
    }
    if (!isValidScore(r?.score)) {
      return NextResponse.json({ error: 'คะแนนต้องเป็น 1–5' }, { status: 400 })
    }
    // Per-criterion scores describe how a TEAM worked; the overall row carries
    // one satisfaction score and free text, so anything sent alongside it is
    // dropped rather than stored under a criterion it does not mean.
    const scores: Record<string, number> = {}
    if (!isOverallTarget(r.targetRole)) {
      for (const [k, v] of Object.entries(r?.scores || {})) {
        if (!isCriterionKey(k)) continue
        if (!isValidScore(v)) return NextResponse.json({ error: `คะแนนหัวข้อ "${k}" ต้องเป็น 1–5` }, { status: 400 })
        scores[k] = v as number
      }
    }
    const comment = typeof r?.comment === 'string' ? r.comment.trim().slice(0, 2000) : ''
    rows.push({ targetRole: r.targetRole, score: r.score, scores, comment: comment || null })
  }

  // createMany + skipDuplicates: a re-submit adds nothing and overwrites nothing.
  const res = await prisma.shootReview.createMany({
    data: rows.map(r => ({
      bookingId: invite.bookingId,
      bookingCode: invite.booking.bookingCode,
      shootDate: invite.booking.shootDate,
      raterEmail: invite.email,
      raterRole: invite.role,
      targetRole: r.targetRole,
      score: r.score,
      scores: r.scores,
      comment: r.comment,
    })),
    skipDuplicates: true,
  })
  if (!invite.submittedAt) {
    await prisma.shootReviewInvite.update({ where: { id: invite.id }, data: { submittedAt: new Date() } })
  }

  // Audit records THAT a form came back — nothing about WHO or WHOM.
  //
  // This row deliberately does NOT use entityType 'Booking': GET
  // /api/bookings/:id/history returns every 'Booking' audit row RAW (changes
  // payload included) to ANY signed-in user, so a row carrying `raterRole`
  // would tell the rated producer which team just reviewed them — and on a
  // normal shoot there is one sound engineer and one camera lead, so the team
  // names the person. That is the exact promise this feature makes to crew.
  // Keyed to the INVITE instead, and stripped of role/target detail.
  logAudit({
    actorEmail: 'shoot-review',
    action: 'review.submitted',
    entityType: 'ShootReviewInvite',
    entityId: invite.id,
    changes: { invite: tokenFingerprint(params.token), created: res.count },
  })

  return NextResponse.json({
    ok: true,
    created: res.count,
    duplicate: res.count < rows.length,
  })
}
