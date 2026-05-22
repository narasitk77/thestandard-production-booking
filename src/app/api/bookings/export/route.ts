/**
 * GET /api/bookings/export?scope=producer
 *
 * CSV of the caller's bookings for reports. scope=producer → shoots where the
 * user is the Producer (producerEmail). Admins (no scope) export everything.
 * UTF-8 with BOM so Excel opens Thai cleanly.
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { buildCSVHeader, rowToCSV, csvFilename } from '@/lib/csv'

const COLUMNS = [
  'Production / Booking ID',
  'Project ID',
  'Status',
  'Shoot Date',
  'Call Time',
  'Wrap',
  'Outlet',
  'Program',
  'Episode IDs',
  'Assigned',
  'Producer',
  'Created At',
]

function d(date: Date | null | undefined): string {
  if (!date) return ''
  try { return new Date(date).toISOString().slice(0, 10) } catch { return '' }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const scope = new URL(request.url).searchParams.get('scope')
  const where =
    scope === 'producer'
      ? { producerEmail: { equals: session.email, mode: 'insensitive' as const } }
      : session.role === 'ADMIN'
        ? {}
        : { OR: [{ createdByEmail: session.email }, { assignedEmails: { has: session.email } }] }

  const bookings = await prisma.booking.findMany({
    where,
    include: { outlet: true, program: true, episodes: { orderBy: { sequence: 'asc' } } },
    orderBy: [{ shootDate: 'desc' }, { createdAt: 'desc' }],
    take: 2000,
  })

  let csv = buildCSVHeader(COLUMNS)
  for (const b of bookings) {
    csv +=
      rowToCSV([
        b.bookingCode || b.id,
        b.projectId || '',
        b.status,
        d(b.shootDate),
        b.callTime,
        b.estimatedWrap || '',
        b.outlet.name,
        b.program.name,
        b.episodes.map(e => e.episodeId).join(', '),
        (b.assignedEmails || []).join(', '),
        b.producer,
        d(b.createdAt),
      ]) + '\n'
  }

  const today = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('bookings', today, today)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
