import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { listCalendarEvents, buildEventTitle, updateCalendarEventDetails } from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PROD_ID_RE = /Production ID:\s*([A-Z0-9-]+)/

/**
 * POST /api/admin/calendar-refresh  { apply?, days? }
 *
 * v1.111 — sweep upcoming app-calendar events whose TITLE no longer matches the
 * current title builder (e.g. events created before bookingDisplayName showed
 * the real show for calendar-migrated bookings — they still say
 * "[NWS] Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว — Now") and rebuild them from
 * the booking (title + description + times, sendUpdates 'none' — a format
 * refresh is not a schedule change). Dry-run default; reports old → new per
 * booking. Only touches each booking's REFERENCED calendarEventId.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const days = Math.min(365, Math.max(1, parseInt(body?.days, 10) || 90))

    const now = new Date()
    const events = await listCalendarEvents({
      timeMin: new Date(now.getTime() - 24 * 3600_000).toISOString(),
      timeMax: new Date(now.getTime() + days * 24 * 3600_000).toISOString(),
    })

    const codes = Array.from(new Set(events.map(e => e.description.match(PROD_ID_RE)?.[1]).filter((v): v is string => !!v)))
    const bookings = codes.length
      ? await prisma.booking.findMany({
          where: { bookingCode: { in: codes }, deletedAt: null },
          include: {
            outlet: true,
            program: true,
            episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
          },
        })
      : []
    const bmap = new Map(bookings.map(b => [b.bookingCode!, b]))

    const changed: Array<{ code: string; eventId: string; oldTitle: string; newTitle: string; updated?: boolean; error?: string }> = []
    for (const e of events) {
      const code = e.description.match(PROD_ID_RE)?.[1]
      if (!code) continue
      const b = bmap.get(code)
      if (!b || b.calendarEventId !== e.id) continue // only the referenced event
      const newTitle = buildEventTitle(b)
      if (newTitle === e.summary) continue
      const entry: (typeof changed)[number] = { code, eventId: e.id, oldTitle: e.summary, newTitle }
      if (apply) {
        try {
          const ok = await updateCalendarEventDetails(e.id, b as any, { sendUpdates: 'none' })
          entry.updated = !!ok
        } catch (err: any) {
          entry.error = err?.message || String(err)
        }
      }
      changed.push(entry)
    }

    if (apply && changed.length > 0) {
      logAudit({
        actorEmail: session.email,
        action: 'calendar.titles_refreshed',
        entityType: 'Calendar',
        entityId: null,
        changes: { count: changed.length, changed: changed.map(c => ({ code: c.code, oldTitle: c.oldTitle, newTitle: c.newTitle })) },
      })
    }

    return NextResponse.json({ ok: true, dryRun: !apply, scanned: events.length, changed })
  } catch (e: any) {
    console.error('POST /api/admin/calendar-refresh error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
