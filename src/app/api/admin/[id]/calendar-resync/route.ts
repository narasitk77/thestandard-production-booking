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
 * Response: ReconcileItem from src/lib/calendar-reconcile.ts, plus { ok }.
 *   { ok: true|false, bookingId, bookingCode, eventId, htmlLink,
 *     action: 'ok' | 'patched' | 'created' | 'failed' | 'skipped',
 *     assignedEmails, calendarAttendees?, error? }
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireAdmin()
  if (!session) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  try {
    const item = await reconcileSingleBooking(params.id, { actorEmail: session.email })
    if (!item) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    const ok = item.action !== 'failed'
    return NextResponse.json({ ok, ...item }, { status: ok ? 200 : 500 })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/calendar-resync error:', e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 },
    )
  }
}

// GET alias for ad-hoc browser triggering by admins.
export async function GET(
  request: NextRequest,
  ctx: { params: { id: string } },
) {
  return POST(request, ctx)
}
