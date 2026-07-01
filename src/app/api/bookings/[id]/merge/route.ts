import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { runBookingMerge, BOOKING_MERGE_SELECT } from '@/lib/booking-merge'
import { clearFootageCache } from '@/lib/footage-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // moving/copying this booking's files can take a bit

/**
 * POST /api/bookings/[id]/merge — consolidate THIS booking's footage into its box:
 *   1. MOVE the NAS "Production Team" landing footage into the VIDEO 2026 box.
 *   2. Fold the staged Sound audio (_SOUND-STAGING) into the box AUDIO folder.
 *
 * Scoped to one booking so it's fast (no system-wide Drive walk → no 60s proxy
 * timeout), unlike the admin-wide /api/internal/{video,sound}-merge sweeps (the
 * hourly workers). Access: same read-scope as detect-footage (canViewBooking).
 * ?dryRun=1 previews without moving/copying.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: BOOKING_MERGE_SELECT,
    })
    if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'

    const result = await runBookingMerge(booking, { dryRun })
    // Footage just moved/copied into the box → invalidate the detect cache so the
    // next scan reflects it (the client re-runs detect right after this).
    if (!dryRun) await clearFootageCache(params.id)
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/merge error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
