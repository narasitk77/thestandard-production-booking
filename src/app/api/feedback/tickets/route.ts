/**
 * GET /api/feedback/tickets — v1.166.
 *
 * Two audiences, one route, and the scope is decided by the SERVER:
 *   - console user (hasConsoleAccess) → every ticket, optionally ?status=
 *   - anyone else                     → only the tickets they reported
 * A normal user can never widen their scope by passing a parameter.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { isFeedbackStatus } from '@/lib/feedback'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = hasConsoleAccess(session.role)
  const sp = new URL(request.url).searchParams
  const status = sp.get('status')

  const tickets = await prisma.feedbackTicket.findMany({
    where: {
      ...(admin ? {} : { reporterEmail: session.email }),
      ...(status && isFeedbackStatus(status) ? { status } : {}),
    },
    // NOTE: deliberately NOT `orderBy: status` — alphabetically that yields
    // IN_PROGRESS, NEW, RESOLVED, which buries the tickets nobody has touched.
    // The intended order lives in STATUS_ORDER and is applied below.
    orderBy: [{ lastMessageAt: 'desc' }],
    take: 200,
    select: {
      id: true, number: true, reporterEmail: true, mood: true, page: true,
      subject: true, status: true, resolution: true, resolvedAt: true,
      createdAt: true, lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  })

  // Unanswered first, then in-flight, then closed; newest activity within each.
  const STATUS_ORDER: Record<string, number> = { NEW: 0, IN_PROGRESS: 1, RESOLVED: 2 }
  tickets.sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
    b.lastMessageAt.getTime() - a.lastMessageAt.getTime())

  const counts = admin
    ? await prisma.feedbackTicket.groupBy({ by: ['status'], _count: { _all: true } })
    : []

  return NextResponse.json({
    admin,
    tickets,
    counts: Object.fromEntries(counts.map(c => [c.status, c._count._all])),
  })
}
