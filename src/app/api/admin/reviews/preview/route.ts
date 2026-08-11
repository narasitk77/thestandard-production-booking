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
 * v1.173.4 — gated on ACTIVITY, not content: this mints a form for the CALLER
 * and reveals nobody else's answers, so the operator can still see what the team
 * receives. An invite is a bearer credential, so it is still not a general admin
 * power.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canSeeReviewActivity, REVIEW_TARGET_ROLES, targetsFor } from '@/lib/review-access'
import { newInviteToken, classifyRater, presentRoles, buildInviteMail } from '@/lib/shoot-review'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canSeeReviewActivity(session.email)) {
    return NextResponse.json({ error: 'ไม่มีสิทธิ์' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({} as any))
  const code = String(body?.bookingCode || '').trim()

  // Default to the most recent finished shoot — the same population the nightly
  // sender works on, so the preview reflects reality.
  // The relations are part of the SELECT because the mail names the job; a plain
  // findFirst returns scalars only and the subject would read "งานถ่าย".
  const withJobName = {
    program: { select: { name: true } },
    outlet: { select: { name: true } },
    episodes: { orderBy: { sequence: 'asc' as const }, select: { title: true }, take: 1 },
  }
  const booking = code
    ? await prisma.booking.findFirst({ where: { bookingCode: code, deletedAt: null }, include: withJobName })
    : await prisma.booking.findFirst({
        where: { deletedAt: null, status: { notIn: ['CANCELLED', 'REQUESTED'] }, shootDate: { lte: new Date() } },
        orderBy: { shootDate: 'desc' },
        include: withJobName,
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

  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  const url = `${appUrl}/review/${invite.token}`

  // v1.173.5 — `sendMail: true` posts the invite to the CALLER's own inbox, so
  // the operator can read what the team will read, in a real mail client, before
  // deciding to switch the feature on. Reading the copy in a code review is not
  // the same as finding it between two other mails on a phone.
  //
  // The recipient is session.email and nothing else — no address is taken from
  // the request. This endpoint must never become a way to mail a third party.
  let mailed = false
  let mailError: string | null = null
  if (body?.sendMail === true) {
    if (!isEmailConfigured()) {
      mailError = 'ระบบอีเมลยังไม่ได้ตั้งค่า'
    } else {
      try {
        const what = [booking.program?.name, booking.episodes?.[0]?.title]
          .filter(Boolean).join(' · ') || (booking.outlet?.name ?? 'งานถ่าย')
        await sendEmail({
          to: session.email,
          ...buildInviteMail({
            what,
            shootDateTh: new Date(booking.shootDate).toLocaleDateString('th-TH-u-ca-gregory', { dateStyle: 'medium' }),
            bookingCode: booking.bookingCode,
            // `voice` overrides the WORDING only, so the operator can read the
            // crew letter even though his own role on this job is not crew. The
            // invite row keeps his real role, which is what the form obeys.
            raterRole: body?.voice === 'crew' ? 'camera'
              : body?.voice === 'client' ? 'producer'
              : myRole,
            targets: finalTargets,
            url,
          }),
        })
        mailed = true
        // A mail really did go out for this invite, so stop reporting it as an
        // undelivered one on the monitor.
        if (!invite.mailedAt) {
          await prisma.shootReviewInvite.update({ where: { id: invite.id }, data: { mailedAt: new Date() } })
        }
      } catch (e: any) {
        mailError = e?.message || 'ส่งอีเมลไม่สำเร็จ'
        console.error('[review-preview] self-send failed:', mailError)
      }
    }
  }

  logAudit({
    actorEmail: session.email,
    action: 'review.preview_minted',
    entityType: 'ShootReviewInvite',
    entityId: invite.id,
    changes: { reused: !!existing, role: myRole, targets: finalTargets, mailedToSelf: mailed },
  })

  return NextResponse.json({
    ok: true,
    reused: !!existing,
    url,
    booking: { code: booking.bookingCode, shootDate: booking.shootDate },
    yourRole: myRole,
    targets: finalTargets,
    mailed,
    mailError,
    note: mailed
      ? 'ส่งอีเมลฉบับจริงไปที่เมลของคุณคนเดียว — ไม่มีใครอื่นได้รับ'
      : 'ไม่มีการส่งอีเมลถึงใคร — ลิงก์นี้ออกให้คุณคนเดียว',
  })
}
