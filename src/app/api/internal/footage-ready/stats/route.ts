/**
 * GET /api/internal/footage-ready/stats[?days=7]
 *
 * v1.181 — the outcome side of the footage-ready feature, for the scheduled
 * watchers (Hermes cron + the nightly Claude Code check) and for an admin
 * eyeballing it by hand. `/api/health-summary` answers "did the worker tick";
 * this answers "did a person on the job get the mail", which is the question
 * that went unanswered for five weeks while every other signal read green.
 *
 * Read-only: no writes, no Drive walks, no sends. Safe to poll.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { footageReadyAudience } from '@/lib/footage-ready'
import { isPhotoAlbumBooking, PHOTO_ALBUM_EPISODE_CODE } from '@/lib/outlet-folders'
import { isShootOver } from '@/lib/shoot-window'
import {
  summarizeSends, bucketPending, footageReadyAlerts,
  type SendRow, type PendingBooking,
} from '@/lib/footage-ready-health'

export const dynamic = 'force-dynamic'

const DAY = 86_400_000

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function enabled(v: string | undefined): boolean {
  const s = (v || '').trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false' && s !== 'off'
}

export async function GET(request: NextRequest) {
  const allowed =
    internalSecretAllowed(request, 'x-footage-ready-secret',
      ['FOOTAGE_READY_SECRET', 'REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']) ||
    (await getSession())?.role === 'ADMIN'
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = new Date()
  const askedDays = Number(new URL(request.url).searchParams.get('days'))
  const windowDays = Math.min(Math.max(Number.isFinite(askedDays) && askedDays > 0 ? Math.floor(askedDays) : 7, 1), 60)
  const since = new Date(now.getTime() - windowDays * DAY)
  const lookbackDays = envInt('FOOTAGE_READY_LOOKBACK_DAYS', 3)

  // ── what actually went out ────────────────────────────────────────────────
  const auditRows = await prisma.auditLog.findMany({
    where: { action: 'booking.auto_notified_ready', at: { gte: since } },
    orderBy: { at: 'asc' },
    select: { bookingCode: true, at: true, changes: true },
  })
  const sends = summarizeSends(auditRows.map((r): SendRow => {
    const c = r.changes as { recipients?: unknown } | null
    const list = Array.isArray(c?.recipients) ? (c!.recipients as unknown[]) : []
    return { bookingCode: r.bookingCode, at: r.at, recipients: list.filter((v): v is string => typeof v === 'string') }
  }))

  // ── what is still waiting, and what the auto path has already given up on ──
  // Deliberately NOT limited to the lookback window: the aged-out bucket only
  // exists because those rows fell out of it, so the query has to see further
  // back than the worker does.
  const candidates = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      cancelRequestedAt: null,
      bookingCode: { not: null },
      readyNotifiedAt: null,
      deliveredAt: null,
      shootDate: { gte: new Date(now.getTime() - Math.max(windowDays, lookbackDays + 4) * DAY) },
    },
    select: {
      bookingCode: true, shootDate: true, shootEndDate: true, estimatedWrap: true,
      readyCheckedAt: true, footageCache: true, footageCacheAt: true,
      program: { select: { code: true } },
      episodes: { select: { program: { select: { code: true } } } },
    },
  })
  const pendingRows: PendingBooking[] = candidates
    .filter(b => isShootOver({ shootDate: b.shootDate, shootEndDate: b.shootEndDate, estimatedWrap: b.estimatedWrap }, now))
    .map(b => {
      const c = b.footageCacheAt ? (b.footageCache as { fileCount?: unknown } | null) : null
      // Window on the LAST day of the shoot — same OR the worker's query uses.
      const end = b.shootEndDate && b.shootEndDate > b.shootDate ? b.shootEndDate : b.shootDate
      return {
        bookingCode: b.bookingCode,
        windowDate: end,
        fileCount: typeof c?.fileCount === 'number' ? c.fileCount : 0,
        walkedAt: b.readyCheckedAt ?? null,
        // The same two-sided photo-album gate the sweep applies (booking program
        // AND episode programs) — otherwise a lighting-only job nags forever.
        skippedByDesign:
          isPhotoAlbumBooking(b.episodes) ||
          (b.program?.code || '').toUpperCase() === PHOTO_ALBUM_EPISODE_CODE,
      }
    })
  const pending = bucketPending(pendingRows, now, lookbackDays)

  // Denominator for "silent window": shoots that ENDED inside the window.
  const shootsOver = await prisma.booking.count({
    where: {
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      cancelRequestedAt: null,
      shootDate: { gte: since, lt: now },
    },
  })

  const config = {
    workerEnabled: enabled(process.env.FOOTAGE_READY_WORKER_ENABLED),
    audience: footageReadyAudience(),
    lookbackDays,
    settleHours: Math.round(envInt('FOOTAGE_READY_SETTLE_MS', 2 * 60 * 60_000) / 360_000) / 10,
    intervalMinutes: Math.round(envInt('FOOTAGE_READY_INTERVAL_MS', 30 * 60_000) / 60_000),
    maxPerRun: envInt('FOOTAGE_READY_MAX_PER_RUN', 5),
  }

  const alerts = footageReadyAlerts({
    workerEnabled: config.workerEnabled,
    audience: config.audience,
    windowDays,
    sends,
    pending,
    shootsOver,
  })

  return NextResponse.json({ ok: alerts.length === 0, windowDays, config, shootsOver, sends, pending, alerts })
}
