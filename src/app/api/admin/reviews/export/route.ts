/**
 * GET /api/admin/reviews/export?days=1 — v1.166. CSV of the raw review rows.
 *
 * The operator asked to be able to export daily; `days` defaults to 1 so the
 * no-argument call is exactly "yesterday and today's". Same three-person gate as
 * the report — this file contains rater identities, so it is the single most
 * sensitive response the app produces.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canReadReviews } from '@/lib/review-access'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/** Excel/Sheets treat a leading =,+,-,@ as a formula — neutralise it. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canReadReviews(session.email)) {
    return NextResponse.json({ error: 'ไม่มีสิทธิ์ดูผลประเมิน' }, { status: 403 })
  }

  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days') ?? 1)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = await prisma.shootReview.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true, bookingId: true, bookingCode: true, shootDate: true,
      raterEmail: true, raterRole: true, targetRole: true,
      score: true, scores: true, comment: true,
    },
  })

  // Display-only context; the rating itself carries code + date so an export
  // stays correct even for bookings that were purged or renamed.
  const ids = Array.from(new Set(rows.map(r => r.bookingId)))
  const ctxRows = ids.length
    ? await prisma.booking.findMany({
        where: { id: { in: ids } },
        select: { id: true, outlet: { select: { name: true } }, program: { select: { name: true } } },
      })
    : []
  const ctx = new Map(ctxRows.map(b => [b.id, b]))

  // Reading the raw identities is itself worth a trail.
  logAudit({
    actorEmail: session.email,
    action: 'review.exported',
    entityType: 'ShootReview',
    entityId: 'export',
    changes: { days, rows: rows.length },
  })

  const header = ['at', 'production_id', 'shoot_date', 'outlet', 'show', 'rater_email', 'rater_role', 'target_role', 'score', 'scores_json', 'comment']
  const body = rows.map(r => [
    r.createdAt.toISOString(),
    r.bookingCode ?? '',
    r.shootDate ? r.shootDate.toISOString().slice(0, 10) : '',
    ctx.get(r.bookingId)?.outlet?.name ?? '',
    ctx.get(r.bookingId)?.program?.name ?? '',
    r.raterEmail, r.raterRole, r.targetRole, r.score,
    JSON.stringify(r.scores ?? {}),
    r.comment ?? '',
  ].map(csvCell).join(','))

  const csv = '﻿' + [header.map(csvCell).join(','), ...body].join('\n')
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="shoot-reviews-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
