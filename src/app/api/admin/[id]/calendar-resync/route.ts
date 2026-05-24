import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { reconcileSingleBooking } from '@/lib/calendar-reconcile'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/calendar-resync
 *
 * Admin-triggered single-booking calendar reconcile. Powers the "Re-sync"
 * button on /admin booking cards. Synchronous — the response carries the
 * resolved calendar state so the UI can render a confirmation toast.
 *
 * Same logic as the background reconciler worker; this endpoint just lets
 * an admin force a run for one booking instead of waiting for the next
 * 10-minute tick.
 *
 * GET /api/admin/[id]/calendar-resync?dryRun=1
 *
 * v1.32.3 — read-only verification mode. Used by /admin/[id]'s
 * Confirmed card on page load to fetch the actual Google Calendar
 * attendees + diff against booking.assignedEmails WITHOUT writing
 * anything. The dry-run path is the same `reconcileSingleBooking()`
 * function with `dryRun: true` so the response shape is identical to
 * POST — just no mutation.
 *
 * Response: ReconcileItem from src/lib/calendar-reconcile.ts, plus { ok }.
 *   { ok: true|false, bookingId, bookingCode, eventId, htmlLink,
 *     action: 'ok' | 'patched' | 'created' | 'failed' | 'skipped',
 *     assignedEmails, calendarAttendees?, error? }
 */
async function run(
  params: { id: string },
  actorEmail: string,
  dryRun: boolean,
) {
  const item = await reconcileSingleBooking(params.id, { actorEmail, dryRun })
  if (!item) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }
  const ok = item.action !== 'failed'
  return NextResponse.json({ ok, ...item }, { status: ok ? 200 : 500 })
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireAdmin()
  if (!session) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  try {
    return await run(params, session.email, /* dryRun */ false)
  } catch (e: any) {
    console.error('POST /api/admin/[id]/calendar-resync error:', e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 },
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireAdmin()
  if (!session) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  // v1.32.3 — `?dryRun=1` opts into the read-only verification path
  // used by /admin/[id]. Without the flag, GET still triggers a real
  // reconcile (backwards compat with prior ad-hoc browser usage).
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === '1' ||
                 url.searchParams.get('dryRun') === 'true'
  try {
    return await run(params, session.email, dryRun)
  } catch (e: any) {
    console.error('GET /api/admin/[id]/calendar-resync error:', e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 },
    )
  }
}
