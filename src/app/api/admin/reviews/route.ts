/**
 * GET /api/admin/reviews — v1.166. The ONLY door review content leaves by.
 *
 * Gated on `canReadReviewContent` (the managers), not on the ADMIN role: the
 * console has several admins and the operator named exactly three. Every other
 * signed-in user — including admins and including the people being rated —
 * gets 403 with no hint that anything exists.
 *
 * There is deliberately no DELETE and no PATCH on this resource anywhere in the
 * app: the record is append-only by operator rule.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canReadReviewContent } from '@/lib/review-access'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canReadReviewContent(session.email)) {
    return NextResponse.json({ error: 'ข้อความประเมินเปิดอ่านได้เฉพาะหัวหน้าทีม (ปุ๊ก · หวาน) — ผู้ดูแลระบบดูความเคลื่อนไหวได้ที่ /admin/monitor' }, { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const days = Math.min(365, Math.max(1, Number(sp.get('days') ?? 90)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const reviews = await prisma.shootReview.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 1000,
    select: {
      id: true, bookingId: true, bookingCode: true, shootDate: true,
      raterEmail: true, raterRole: true,
      targetRole: true, score: true, scores: true, comment: true, createdAt: true,
    },
  })

  // Outlet/show are display-only and live on the booking, which ShootReview no
  // longer has an FK to (a rating must survive its booking being purged). One
  // batched lookup; rows whose booking is gone simply show the snapshotted code.
  const bookingIds = Array.from(new Set(reviews.map(r => r.bookingId)))
  const ctxRows = bookingIds.length
    ? await prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: { id: true, program: { select: { name: true } }, outlet: { select: { name: true } } },
      })
    : []
  const ctx = new Map(ctxRows.map(b => [b.id, b]))

  // Per-team averages over the window, so the page opens on the trend rather
  // than on individual comments.
  const byTarget: Record<string, { n: number; sum: number }> = {}
  for (const r of reviews) {
    const t = (byTarget[r.targetRole] ||= { n: 0, sum: 0 })
    t.n++; t.sum += r.score
  }
  const summary = Object.entries(byTarget).map(([role, v]) => ({
    role, count: v.n, average: Math.round((v.sum / v.n) * 100) / 100,
  }))

  const invites = await prisma.shootReviewInvite.count({ where: { sentAt: { gte: since } } })
  const answered = await prisma.shootReviewInvite.count({ where: { sentAt: { gte: since }, submittedAt: { not: null } } })

  const withCtx = reviews.map(r => ({
    ...r,
    booking: {
      bookingCode: r.bookingCode,
      shootDate: r.shootDate,
      program: ctx.get(r.bookingId)?.program ?? null,
      outlet: ctx.get(r.bookingId)?.outlet ?? null,
    },
  }))

  return NextResponse.json({
    days, summary, reviews: withCtx,
    responseRate: invites > 0 ? Math.round((answered / invites) * 100) : null,
    invites, answered,
  })
}
