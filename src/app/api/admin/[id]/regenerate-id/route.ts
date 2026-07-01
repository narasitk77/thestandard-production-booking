import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { computeTypeDroppedId, regenerateBookingId } from '@/lib/regenerate-booking-id'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/admin/[id]/regenerate-id   { dryRun?, notifyCalendar? }
 *
 * Regenerate ONE booking's Production/Episode ID to the current-format (v1.109:
 * drop the legacy [TYPE] segment), cascading the rename to the Drive box + sheet
 * + calendar via the shared primitive. Admin-only. Returns { noChange:true } when
 * the code is already type-less, and 409 on a bookingCode collision.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const dryRun = body?.dryRun === true
    const notifyCalendar = body?.notifyCalendar === true

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: { id: true, bookingCode: true, episodes: { select: { id: true, episodeId: true } } },
    })
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    if (!booking.bookingCode) return NextResponse.json({ error: 'Booking has no code to regenerate' }, { status: 400 })

    const newCode = computeTypeDroppedId(booking.bookingCode)
    const episodeChanges = booking.episodes
      .map(ep => {
        const next = computeTypeDroppedId(ep.episodeId)
        return next && next !== ep.episodeId ? { episodeDbId: ep.id, newEpisodeId: next } : null
      })
      .filter((c): c is { episodeDbId: string; newEpisodeId: string } => c !== null)

    if (!newCode && episodeChanges.length === 0) {
      return NextResponse.json({ ok: true, noChange: true, message: 'ID นี้เป็นรูปแบบล่าสุดอยู่แล้ว (ไม่มี segment เก่าให้ตัด)', oldCode: booking.bookingCode })
    }

    const result = await regenerateBookingId({
      bookingId: booking.id,
      newBookingCode: newCode ?? booking.bookingCode,
      episodeChanges,
      actorEmail: session.email,
      dryRun,
      notifyCalendar,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Regenerate failed', result }, { status: 409 })
    }
    return NextResponse.json({ ok: true, result })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/regenerate-id error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
