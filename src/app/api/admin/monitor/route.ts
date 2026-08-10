/**
 * GET /api/admin/monitor — v1.170. The operator's morning glance.
 *
 * One request, four answers: what is due today, did it go out, is anyone
 * replying, is anything stuck. Everything is computed server-side so the panel
 * cannot drift from the sender's own rules — `dueWindow` and the delay come
 * from the same modules the worker uses.
 *
 * Three audiences, three gates, one response (v1.173.4):
 *   - review CONTENT (score averages) → the managers only
 *   - review ACTIVITY (did it go out, did anyone answer, what is stuck) → the
 *     managers plus the operator, who runs the pipeline but does not read it
 *   - ticket numbers → console staff (a feedback queue is not secret)
 * A console user with neither gets `reviews: null` rather than a 403 for the
 * whole page.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { canReadReviewContent, canSeeReviewActivity } from '@/lib/review-access'
import {
  reviewsEnabled, reviewDelayDays, reviewLookbackDays, dueWindow, buildInvites,
} from '@/lib/shoot-review'
import {
  responseRate, undelivered, awaitingReply, rateHealth, deliveryHealth,
  medianResolveHours, oldestOpenDays, queueHealth,
} from '@/lib/review-ops'
import { startOfTodayBangkok } from '@/lib/bangkok-day'
import { isShootOver } from '@/lib/shoot-window'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasConsoleAccess(session.role)) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  const now = new Date()
  const since30 = new Date(now.getTime() - 30 * 86_400_000)

  // ── feedback tickets (console) ────────────────────────────────────────────
  const tickets = await prisma.feedbackTicket.findMany({
    select: { status: true, createdAt: true, resolvedAt: true, lastMessageAt: true },
  })
  const openList = await prisma.feedbackTicket.findMany({
    where: { status: { not: 'RESOLVED' } },
    orderBy: { createdAt: 'asc' },
    take: 10,
    select: { id: true, number: true, subject: true, status: true, reporterEmail: true, createdAt: true, lastMessageAt: true },
  })
  const ticketStats = {
    new: tickets.filter(t => t.status === 'NEW').length,
    inProgress: tickets.filter(t => t.status === 'IN_PROGRESS').length,
    resolved30d: tickets.filter(t => t.status === 'RESOLVED' && t.resolvedAt && t.resolvedAt >= since30).length,
    medianResolveHours: medianResolveHours(tickets),
    oldestOpenDays: oldestOpenDays(tickets, now),
    health: queueHealth(tickets, now),
    open: openList,
  }

  if (!canSeeReviewActivity(session.email)) {
    return NextResponse.json({ tickets: ticketStats, reviews: null, now: now.toISOString() })
  }
  // v1.173.4 — the operator gets the PIPELINE (did it go out, did anyone answer);
  // the score averages are review content and belong to the managers. On a
  // two-person shoot a per-team average IS one person's rating of another.
  const showContent = canReadReviewContent(session.email)

  // ── review pipeline ───────────────────────────────────────────────────────
  const delay = reviewDelayDays()
  const lookback = reviewLookbackDays()
  const { from, to } = dueWindow(startOfTodayBangkok(), delay, lookback)

  // What the worker WOULD pick up on its next run — the same population as the
  // sender, or the panel promises a batch the worker will not send.
  //
  // The sender triggers on COMPLETED and closes anything overdue itself
  // (autoCompleteBookings). This is a read-only panel, so instead of writing,
  // it pulls CONFIRMED rows too and keeps the ones whose shoot is genuinely over
  // — exactly the set the sender will have closed by the time it queries.
  const windowBookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: ['COMPLETED', 'CONFIRMED'] },
      OR: [
        { shootEndDate: { gte: from, lte: to } },
        { shootEndDate: null, shootDate: { gte: from, lte: to } },
      ],
    },
    orderBy: { shootDate: 'asc' },
    select: {
      id: true, bookingCode: true, shootDate: true, shootEndDate: true, estimatedWrap: true,
      status: true, deletedAt: true,
      producerEmail: true, createdByEmail: true, assignedEmails: true,
      mainVideographerEmail: true, crewRequired: true,
      program: { select: { name: true } }, outlet: { select: { name: true } },
    },
  })
  const dueBookings = windowBookings.filter(b => b.status === 'COMPLETED' || isShootOver(b, now))

  const roster = await prisma.teamMember.findMany({ select: { email: true, role: true } }).catch(() => [])
  const rosterRoleByEmail: Record<string, string> = {}
  for (const m of roster) if (m.email) rosterRoleByEmail[m.email.toLowerCase()] = m.role

  const dueIds = dueBookings.map(b => b.id)
  const dueInvites = dueIds.length
    ? await prisma.shootReviewInvite.findMany({
        where: { bookingId: { in: dueIds } },
        select: { bookingId: true, email: true, sentAt: true, mailedAt: true, submittedAt: true },
      })
    : []

  const allRows = dueBookings.map(b => {
    const mine = dueInvites.filter(i => i.bookingId === b.id)
    // How many the sender would create if it ran right now — so a row reading
    // "0 / 4" is visibly "nothing sent yet", not "nobody to ask".
    const wouldInvite = buildInvites(b, rosterRoleByEmail).length
    return {
      code: b.bookingCode,
      show: b.program?.name || b.outlet?.name || null,
      status: b.status,
      shootDate: (b.shootEndDate ?? b.shootDate).toISOString().slice(0, 10),
      expected: wouldInvite,
      invited: mine.length,
      mailed: mine.filter(i => i.mailedAt).length,
      answered: mine.filter(i => i.submittedAt).length,
    }
  })

  // A whole lookback window can be long. Jobs the sender still owes something to
  // come first, and the count of what was left off is reported rather than the
  // table quietly ending.
  const ROW_LIMIT = 20
  const ranked = [...allRows].sort((a, b) =>
    Number(b.mailed < b.expected) - Number(a.mailed < a.expected))
  const todayRows = ranked.slice(0, ROW_LIMIT)
  const rowsOmitted = ranked.length - todayRows.length

  const recentInvites = await prisma.shootReviewInvite.findMany({
    where: { sentAt: { gte: since30 } },
    select: { id: true, bookingId: true, email: true, sentAt: true, mailedAt: true, submittedAt: true },
  })

  // The /admin/reviews preview mints a REAL invite and mails nobody on purpose,
  // so it is not a delivery failure — but it looks exactly like one, and it kept
  // the delivery light red with nothing an operator could do about it.
  //
  // Identified by the audit row written in the same request as the invite, which
  // needs no schema flag. Audit rows age out at 90 days; a 90-day-old un-mailed
  // invite resurfacing here is fine — by then it IS something to look at.
  const previewIds = new Set(
    (await prisma.auditLog.findMany({
      where: { action: 'review.preview_minted', entityType: 'ShootReviewInvite' },
      select: { entityId: true },
    })).map(r => r.entityId),
  )

  const rate30 = responseRate(recentInvites)
  const stuck = undelivered(recentInvites.filter(i => !previewIds.has(i.id)))
  const waiting = awaitingReply(recentInvites, now)

  // Not fetched at all unless the caller may read content — the cheapest way to
  // be sure a score cannot leak through this response is to never load it.
  const byTarget: Record<string, { n: number; sum: number }> = {}
  if (showContent) {
    const reviews = await prisma.shootReview.findMany({
      where: { createdAt: { gte: since30 } },
      select: { targetRole: true, score: true },
    })
    for (const r of reviews) {
      const t = (byTarget[r.targetRole] ||= { n: 0, sum: 0 })
      t.n++; t.sum += r.score
    }
  }

  const lastRun = await prisma.auditLog.findFirst({
    where: { action: 'review.invites_sent' },
    orderBy: { at: 'desc' },
    select: { at: true, changes: true },
  })

  return NextResponse.json({
    now: now.toISOString(),
    tickets: ticketStats,
    reviews: {
      enabled: reviewsEnabled(),
      delayDays: delay,
      lookbackDays: lookback,
      window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      today: todayRows,
      rowsOmitted,
      rate30: { ...rate30, health: rateHealth(rate30.pct) },
      // While the feature is off, NOTHING is sending — an un-mailed invite (the
      // /admin/reviews preview mints one) is then the expected state, not a
      // delivery failure, and a permanently red light is a light nobody reads.
      // The next real run re-sends those with the same token.
      undelivered: {
        count: stuck.length,
        health: reviewsEnabled() ? deliveryHealth(stuck.length) : 'ok' as const,
      },
      awaiting: {
        count: waiting.length,
        oldestDays: waiting[0]?.waitingDays ?? null,
      },
      canReadContent: showContent,
      scores: showContent
        ? Object.entries(byTarget).map(([role, v]) => ({
            role, count: v.n, average: Math.round((v.sum / v.n) * 100) / 100,
          }))
        : null,
      lastRun: lastRun ? { at: lastRun.at, changes: lastRun.changes } : null,
    },
  })
}
