import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { listCalendarEvents, deleteCalendarEvent } from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// The app bakes "Production ID: <code>" into every event description.
const PROD_ID_RE = /Production ID:\s*([A-Z0-9-]+)/

/**
 * POST /api/admin/calendar-dedupe  { apply?, days? }
 *
 * v1.111 — sweep the app calendar for DUPLICATE booking events. A create race
 * (approve / assign auto-recover / reconciler all create while calendarEventId
 * is null) used to leave orphan duplicates: the later persist overwrote the
 * earlier event id, and that event stayed on the calendar (ops report
 * 2026-07-02: two events per booking, ~3s apart, sometimes different times).
 * The creators are now CAS-guarded; this cleans up what already leaked.
 *
 * For each upcoming event with a parsable Production ID:
 *   - booking.calendarEventId set  → events with the same code but a DIFFERENT
 *     id are orphans → delete (apply) / report (dry-run default).
 *   - booking.calendarEventId null → ADOPT the newest event (CAS), delete rest.
 *   - no booking for the code      → report only, never delete.
 * Admin-only.
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

    // Group events by Production ID.
    const byCode = new Map<string, typeof events>()
    let unparsed = 0
    for (const e of events) {
      const m = e.description.match(PROD_ID_RE)
      if (!m) { unparsed++; continue }
      const a = byCode.get(m[1]) || []
      a.push(e)
      byCode.set(m[1], a)
    }

    const codes = Array.from(byCode.keys())
    const bookings = codes.length
      ? await prisma.booking.findMany({
          where: { bookingCode: { in: codes } },
          select: { id: true, bookingCode: true, calendarEventId: true, status: true },
        })
      : []
    const bmap = new Map(bookings.map(b => [b.bookingCode!, b]))

    const results: Array<{ code: string; kept: string | null; deleted: string[]; adopted?: boolean; note?: string }> = []
    let deletedTotal = 0

    for (const [code, evs] of Array.from(byCode)) {
      const b = bmap.get(code)
      if (!b) {
        if (evs.length > 1) results.push({ code, kept: null, deleted: [], note: `no booking — ${evs.length} events left alone` })
        continue
      }
      if (b.status === 'CANCELLED') {
        // Cancel flow owns these events — never adopt/delete here.
        results.push({ code, kept: b.calendarEventId, deleted: [], note: `booking CANCELLED — ${evs.length} event(s) left alone` })
        continue
      }
      let keepId = b.calendarEventId
      let adopted = false
      if (!keepId) {
        // No referenced event → adopt the newest so the booking links up again.
        const newest = [...evs].sort((x, y) => String(y.created).localeCompare(String(x.created)))[0]
        keepId = newest.id
        adopted = true
        if (apply) {
          await prisma.booking.updateMany({
            where: { id: b.id, calendarEventId: null },
            data: { calendarEventId: keepId, calendarSyncStatus: 'OK', calendarSyncError: null, calendarLastSyncedAt: new Date() },
          }).catch(() => {})
        }
      }
      const orphans = evs.filter(e => e.id !== keepId)
      if (orphans.length === 0 && !adopted) continue
      const deleted: string[] = []
      for (const o of orphans) {
        if (apply) {
          const ok = await deleteCalendarEvent(o.id)
          if (ok) { deleted.push(o.id); deletedTotal++ }
        } else {
          deleted.push(o.id)
          deletedTotal++
        }
      }
      results.push({ code, kept: keepId, deleted, ...(adopted ? { adopted: true } : {}) })
    }

    if (apply && deletedTotal > 0) {
      logAudit({
        actorEmail: session.email,
        action: 'calendar.dedupe_swept',
        entityType: 'Calendar',
        entityId: null,
        changes: { deletedTotal, results },
      })
    }

    return NextResponse.json({ ok: true, dryRun: !apply, scannedEvents: events.length, unparsed, duplicates: results, deletedTotal })
  } catch (e: any) {
    console.error('POST /api/admin/calendar-dedupe error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
