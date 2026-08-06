/**
 * POST /api/internal/shoot-reviews/send — v1.166. Nightly invite sender.
 *
 * One day after a shoot (SHOOT_REVIEW_DELAY_DAYS), invite everyone who worked it
 * to rate the other teams. Dormant until SHOOT_REVIEW_ENABLED=1, and dryRun by
 * DEFAULT — a survey that mails the whole crew is not something to fire by
 * accident.
 *
 * Idempotent: the invite row is unique per (booking, email), so re-running sends
 * nothing twice. That is also why the row is created BEFORE the email — a crash
 * mid-send leaves people un-mailed rather than mailed twice, and the next run
 * only picks up whoever has no row yet.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import { buildInvites, newInviteToken, reviewsEnabled, reviewDelayDays } from '@/lib/shoot-review'
import { REVIEW_TARGET_ROLES, ANONYMITY_NOTICE_TH } from '@/lib/review-access'
import { startOfTodayBangkok } from '@/lib/bangkok-day'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ROLE_TH = Object.fromEntries(REVIEW_TARGET_ROLES.map(r => [r.key, r.th]))

function authorised(request: NextRequest): boolean {
  const want = (process.env.RECONCILE_SECRET || process.env.NEXTAUTH_SECRET || '').trim()
  if (!want) return false
  const got = request.headers.get('x-reconcile-secret') || request.headers.get('x-review-secret') || ''
  return got === want
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!reviewsEnabled()) {
    return NextResponse.json({ skipped: true, reason: 'SHOOT_REVIEW_ENABLED != 1' })
  }
  const sp = new URL(request.url).searchParams
  const dryRun = sp.get('dryRun') !== '0'

  // v1.166.1 — the day is BANGKOK's, not UTC's. The worker runs at 03:00 BKK =
  // 20:00 UTC the previous day, so `new Date()` with UTC arithmetic pointed at
  // the wrong calendar day and surveyed the wrong shoots.
  const delay = reviewDelayDays()
  const target = startOfTodayBangkok()
  target.setUTCDate(target.getUTCDate() - delay)

  // Survey after the LAST shoot day: a multi-day shoot must not get the form
  // while the crew is still on set tomorrow.
  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['CANCELLED', 'REQUESTED'] },
      OR: [
        { shootEndDate: target },
        { shootEndDate: null, shootDate: target },
      ],
    },
    select: {
      id: true, bookingCode: true, shootDate: true, status: true, deletedAt: true,
      producerEmail: true, createdByEmail: true, assignedEmails: true,
      mainVideographerEmail: true, crewRequired: true,
      program: { select: { name: true } },
      outlet: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { title: true } },
    },
  })

  const roster = await prisma.teamMember.findMany({ select: { email: true, role: true } }).catch(() => [])
  const rosterRoleByEmail: Record<string, string> = {}
  for (const m of roster) if (m.email) rosterRoleByEmail[m.email.toLowerCase()] = m.role

  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  let invited = 0, mailed = 0, skippedExisting = 0
  const errors: string[] = []
  const details: Array<{ code: string | null; invites: number; resend?: number; emails?: string[] }> = []

  for (const b of bookings) {
    try {
    const invites = buildInvites(b, rosterRoleByEmail)
    if (invites.length === 0) continue

    const existing = await prisma.shootReviewInvite.findMany({
      where: { bookingId: b.id }, select: { id: true, email: true, token: true, mailedAt: true },
    })
    const byEmail = new Map(existing.map(e => [e.email.toLowerCase(), e]))
    // Someone already invited AND mailed is done. Someone with a row but no
    // mailedAt had their email fail on a previous run — re-send with the SAME
    // token so they never get two different links.
    const fresh = invites.filter(i => !byEmail.has(i.email))
    const retry = invites
      .map(i => ({ inv: i, row: byEmail.get(i.email) }))
      .filter(x => x.row && !x.row.mailedAt)
    skippedExisting += invites.length - fresh.length - retry.length
    if (fresh.length === 0 && retry.length === 0) continue

    details.push({ code: b.bookingCode, invites: fresh.length, resend: retry.length, ...(dryRun ? { emails: fresh.map(f => f.email) } : {}) })
    if (dryRun) { invited += fresh.length; continue }

    const work: Array<{ email: string; role: string; targets: string[]; token: string; inviteId: string | null }> = []
    for (const inv of fresh) {
      // Row first (the unique index is what stops a double invite), but with
      // mailedAt null so a failed send is visibly unfinished and retried.
      const row = await prisma.shootReviewInvite.create({
        data: { bookingId: b.id, email: inv.email, role: inv.role, targets: inv.targets, token: newInviteToken() },
        select: { id: true, token: true },
      })
      invited++
      work.push({ ...inv, token: row.token, inviteId: row.id })
    }
    for (const r of retry) {
      work.push({ email: r.inv.email, role: r.inv.role, targets: r.inv.targets, token: r.row!.token, inviteId: r.row!.id })
    }

    for (const inv of work) {
      if (!isEmailConfigured()) continue
      try {
        const what = [b.program?.name, b.episodes[0]?.title].filter(Boolean).join(' · ') || (b.outlet?.name ?? 'งานถ่าย')
        await sendEmail({
          to: inv.email,
          subject: `[ประเมินงาน] ${b.bookingCode || ''} ${what}`.trim(),
          text: [
            'ขอบคุณที่ร่วมงานเมื่อวานครับ 🙏',
            '',
            `งาน: ${what}`,
            `Production ID: ${b.bookingCode || '—'}`,
            `วันถ่าย: ${new Date(b.shootDate).toLocaleDateString('th-TH-u-ca-gregory', { dateStyle: 'medium' })}`,
            '',
            `ขอรบกวนให้คะแนน ${inv.targets.map(t => ROLE_TH[t] || t).join(' และ ')} สัก 1 นาที`,
            'จะได้เอาไปปรับการทำงานร่วมกันให้ดีขึ้น',
            '',
            `${appUrl}/review/${inv.token}`,
            '',
            ANONYMITY_NOTICE_TH,
            '',
            'THE STANDARD Production Booking',
          ].join('\n'),
        })
        mailed++
        if (inv.inviteId) {
          await prisma.shootReviewInvite.update({ where: { id: inv.inviteId }, data: { mailedAt: new Date() } })
        }
      } catch (e: any) {
        // Left with mailedAt null on purpose — the next run re-sends this one.
        console.error(`[shoot-review] email to ${inv.email} failed:`, e?.message || e)
        errors.push(`${b.bookingCode}: ${inv.email} — ${e?.message || e}`)
      }
    }
    } catch (e: any) {
      // One bad booking must not abandon the rest of the night's batch.
      console.error(`[shoot-review] booking ${b.bookingCode} failed:`, e?.message || e)
      errors.push(`${b.bookingCode}: ${e?.message || e}`)
    }
  }

  if (!dryRun && invited > 0) {
    logAudit({
      actorEmail: 'shoot-review-worker',
      action: 'review.invites_sent',
      entityType: 'Booking',
      entityId: 'batch',
      changes: { shootDate: target.toISOString().slice(0, 10), bookings: details.length, invited, mailed },
    })
  }

  return NextResponse.json({
    ok: true, dryRun, shootDate: target.toISOString().slice(0, 10),
    bookingsScanned: bookings.length, invited, mailed, skippedExisting,
    errors, emailConfigured: isEmailConfigured(), details,
  })
}
