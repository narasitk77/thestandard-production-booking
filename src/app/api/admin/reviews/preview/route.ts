/**
 * POST /api/admin/reviews/preview — v1.169. "Show me the form."
 *
 * The peer-review feature is dormant by default, and turning it on means
 * emailing real crew. That left the operator with nothing to look at: a results
 * page with zero rows and no way to see what their team is about to receive.
 *
 * This mints ONE invite, for the CALLER, on a real booking — and sends no
 * email to anybody. It is the same row the nightly sender would create, so the
 * form that opens is the real thing, not a mockup.
 *
 * Restricted to the three review owners (same gate as the results): an invite
 * is a bearer credential, and handing them out is not a general admin power.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canReadReviews, REVIEW_TARGET_ROLES, targetsFor } from '@/lib/review-access'
import { newInviteToken, classifyRater, presentRoles } from '@/lib/shoot-review'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canReadReviews(session.email)) {
    return NextResponse.json({ error: 'ไม่มีสิทธิ์' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({} as any))
  const code = String(body?.bookingCode || '').trim()

  // Default to the most recent finished shoot — the same population the nightly
  // sender works on, so the preview reflects reality.
  const booking = code
    ? await prisma.booking.findFirst({ where: { bookingCode: code, deletedAt: null } })
    : await prisma.booking.findFirst({
        where: { deletedAt: null, status: { notIn: ['CANCELLED', 'REQUESTED'] }, shootDate: { lte: new Date() } },
        orderBy: { shootDate: 'desc' },
      })
  if (!booking) return NextResponse.json({ error: 'ไม่พบงานที่ใช้ทำตัวอย่างได้' }, { status: 404 })

  const roster = await prisma.teamMember.findMany({ select: { email: true, role: true } }).catch(() => [])
  const rosterRoleByEmail: Record<string, string> = {}
  for (const m of roster) if (m.email) rosterRoleByEmail[m.email.toLowerCase()] = m.role

  // Ask about every team that worked the shoot except the caller's own, exactly
  // as buildInvites would. Falling back to all three keeps the preview useful on
  // a booking where the caller has no role at all.
  const myRole = classifyRater(session.email, booking, rosterRoleByEmail)
  const present = presentRoles(booking, ['producer', 'camera', 'sound'])
  const targets = targetsFor(myRole, present)
  const finalTargets = targets.length ? targets : REVIEW_TARGET_ROLES.map(r => r.key).filter(k => k !== myRole)

  // Reuse the caller's existing invite for this booking if there is one — the
  // unique index would reject a second, and a preview must be re-runnable.
  const existing = await prisma.shootReviewInvite.findFirst({
    where: { bookingId: booking.id, email: session.email },
  })
  const invite = existing ?? await prisma.shootReviewInvite.create({
    data: {
      bookingId: booking.id,
      email: session.email,
      role: myRole,
      targets: finalTargets,
      token: newInviteToken(),
      // No email is sent, so mailedAt stays null on purpose — if the feature is
      // ever switched on, the nightly run will mail this person properly.
    },
  })

  logAudit({
    actorEmail: session.email,
    action: 'review.preview_minted',
    entityType: 'ShootReviewInvite',
    entityId: invite.id,
    changes: { reused: !!existing, role: myRole, targets: finalTargets },
  })

  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  return NextResponse.json({
    ok: true,
    reused: !!existing,
    url: `${appUrl}/review/${invite.token}`,
    booking: { code: booking.bookingCode, shootDate: booking.shootDate },
    yourRole: myRole,
    targets: finalTargets,
    note: 'ไม่มีการส่งอีเมลถึงใคร — ลิงก์นี้ออกให้คุณคนเดียว',
  })
}
