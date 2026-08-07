/**
 * GET /api/admin/monitor — v1.170. The operator's morning glance.
 *
 * One request, four answers: what is due today, did it go out, is anyone
 * replying, is anything stuck. Everything is computed server-side so the panel
 * cannot drift from the sender's own rules — `dueShootDay` and the delay come
 * from the same modules the worker uses.
 *
 * Two audiences, two gates, one response:
 *   - review numbers → the three review owners only (they contain who was
 *     asked and who answered, which is rater metadata)
 *   - ticket numbers → console staff (a feedback queue is not secret)
 * A console user who is not a review owner gets `reviews: null` rather than a
 * 403 for the whole page.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { canReadReviews } from '@/lib/review-access'
import { reviewsEnabled, reviewDelayDays, buildInvites } from '@/lib/shoot-review'
import {
  responseRate, undelivered, awaitingReply, rateHealth, deliveryHealth,
  medianResolveHours, oldestOpenDays, queueHealth, dueShootDay,
} from '@/lib/review-ops'

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

  if (!canReadReviews(session.email)) {
    return NextResponse.json({ tickets: ticketStats, reviews: null, now: now.toISOString() })
  }

  // ── review pipeline (owners only) ─────────────────────────────────────────
  const delay = reviewDelayDays()
  const due = dueShootDay(now, delay)

  // What the worker WOULD pick up on its next run. Same query shape as the
  // sender: last shoot day == the due day, live, not cancelled/requested.
  const dueBookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['CANCELLED', 'REQUESTED'] },
      OR: [{ shootEndDate: due }, { shootEndDate: null, shootDate: due }],
    },
    select: {
      id: true, bookingCode: true, shootDate: true, shootEndDate: true, status: true, deletedAt: true,
      producerEmail: true, createdByEmail: true, assignedEmails: true,
      mainVideographerEmail: true, crewRequired: true,
      program: { select: { name: true } }, outlet: { select: { name: true } },
    },
  })

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

  const todayRows = dueBookings.map(b => {
    const mine = dueInvites.filter(i => i.bookingId === b.id)
    // How many the sender would create if it ran right now — so a row reading
    // "0 / 4" is visibly "nothing sent yet", not "nobody to ask".
    const wouldInvite = buildInvites(b, rosterRoleByEmail).length
    return {
      code: b.bookingCode,
      show: b.program?.name || b.outlet?.name || null,
      status: b.status,
      expected: wouldInvite,
      invited: mine.length,
      mailed: mine.filter(i => i.mailedAt).length,
      answered: mine.filter(i => i.submittedAt).length,
    }
  })

  const recentInvites = await prisma.shootReviewInvite.findMany({
    where: { sentAt: { gte: since30 } },
    select: { bookingId: true, email: true, sentAt: true, mailedAt: true, submittedAt: true },
  })
  const rate30 = responseRate(recentInvites)
  const stuck = undelivered(recentInvites)
  const waiting = awaitingReply(recentInvites, now)

  const reviews = await prisma.shootReview.findMany({
    where: { createdAt: { gte: since30 } },
    select: { targetRole: true, score: true },
  })
  const byTarget: Record<string, { n: number; sum: number }> = {}
  for (const r of reviews) {
    const t = (byTarget[r.targetRole] ||= { n: 0, sum: 0 })
    t.n++; t.sum += r.score
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
      dueShootDay: due.toISOString().slice(0, 10),
      today: todayRows,
      rate30: { ...rate30, health: rateHealth(rate30.pct) },
      undelivered: { count: stuck.length, health: deliveryHealth(stuck.length) },
      awaiting: {
        count: waiting.length,
        oldestDays: waiting[0]?.waitingDays ?? null,
      },
      scores: Object.entries(byTarget).map(([role, v]) => ({
        role, count: v.n, average: Math.round((v.sum / v.n) * 100) / 100,
      })),
      lastRun: lastRun ? { at: lastRun.at, changes: lastRun.changes } : null,
    },
  })
}
