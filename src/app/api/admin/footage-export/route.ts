import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { bookingDisplayName } from '@/lib/display'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/admin/footage-export — download the footage log as CSV.
 *
 * v1.111 — replaces the (disabled) footage-sync-to-Google-Sheet worker with an
 * on-demand export. Dumps FootageLog (every detected footage file, incl. files
 * MOVED from the NAS that have no Upload row) enriched with booking context, so
 * ops can pull a spreadsheet whenever they want instead of syncing a live sheet.
 * Console access (Admin/Support/Manager/Coordinator).
 */
export async function GET() {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }

  const logs = await prisma.footageLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100000,
    select: { productionId: true, bookingId: true, filename: true, driveUrl: true, parseStatus: true, createdAt: true },
  })

  // Enrich with booking context (FootageLog has no Prisma relation → manual join).
  const bookingIds = Array.from(new Set(logs.map(l => l.bookingId).filter((v): v is string => !!v)))
  const bookings = bookingIds.length
    ? await prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: {
          id: true, bookingCode: true, shootDate: true,
          projectName: true,
          outlet: { select: { code: true, name: true } },
          program: { select: { name: true } },
          episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { name: true } } } },
        },
      })
    : []
  const bmap = new Map(bookings.map(b => [b.id, b]))

  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['Production ID', 'Booking Code', 'Outlet', 'Show', 'Shoot Date', 'Filename', 'Drive URL', 'Parse Status', 'Detected At']
  const lines = [header.join(',')]
  for (const l of logs) {
    const b = l.bookingId ? bmap.get(l.bookingId) : null
    const show = b ? bookingDisplayName({ projectName: b.projectName, program: b.program, episodes: b.episodes }) : ''
    const shoot = b?.shootDate ? new Date(b.shootDate).toISOString().slice(0, 10) : ''
    lines.push([
      l.productionId || '', b?.bookingCode || '', b?.outlet?.code || '', show, shoot,
      l.filename, l.driveUrl || '', l.parseStatus, l.createdAt.toISOString(),
    ].map(esc).join(','))
  }

  // UTF-8 BOM so Excel opens Thai text correctly.
  const csv = '﻿' + lines.join('\r\n')
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="footage-log-${stamp}.csv"`,
    },
  })
}
