import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { runBookingMerge, startMergeJob, getMergeJobStatus, BOOKING_MERGE_SELECT } from '@/lib/booking-merge'
import { clearFootageCache } from '@/lib/footage-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // the background job keeps the process busy well past the request

/**
 * POST /api/bookings/[id]/merge — consolidate THIS booking's footage into its box:
 *   1. MOVE the NAS "Production Team" landing footage into the VIDEO 2026 box.
 *   2. Fold the staged Sound audio (_SOUND-STAGING) into the box AUDIO folder.
 *
 * v1.113.4 — runs as a BACKGROUND job: a big landing (hundreds of camera-card
 * files) takes minutes to move and the reverse proxy cuts requests at 60s, so
 * the old synchronous route "failed" (504) while the move kept going. POST now
 * starts (or joins) the job and returns { job: { running: true } } immediately;
 * the UI polls GET for status. ?dryRun=1 stays synchronous (read-only preview).
 *
 * GET /api/bookings/[id]/merge — current job status ({ job: { running, done,
 * result, error } }). Access: same read-scope as detect-footage (canViewBooking).
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

    if (dryRun) {
      const result = await runBookingMerge(booking, { dryRun: true })
      return NextResponse.json(result)
    }

    // Footage moves into the box → bust the detect cache when the job lands.
    const status = startMergeJob(params.id, booking, () => clearFootageCache(params.id))
    return NextResponse.json({ job: status }, { status: 202 })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/merge error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: BOOKING_MERGE_SELECT,
    })
    if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json({ job: getMergeJobStatus(params.id) })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/merge error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
