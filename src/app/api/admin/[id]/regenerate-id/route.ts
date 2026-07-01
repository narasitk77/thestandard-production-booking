import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { computeTypeDroppedId, regenerateBookingId } from '@/lib/regenerate-booking-id'
import { planReprogram } from '@/lib/reprogram-booking'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/admin/[id]/regenerate-id   { dryRun?, notifyCalendar?, programByEpisode? }
 *
 * Two modes, both cascading the rename to Drive + sheet + calendar via the shared
 * primitive. Admin-only.
 *   - DEFAULT (no programByEpisode): regenerate to the current format (v1.109 —
 *     drop the legacy [TYPE] segment). Returns { noChange:true } when already clean.
 *   - REPROGRAM ({ programByEpisode: { <episodeDbId>: <programCode> } }): change an
 *     episode's show/รายการ (or add a program code) and recompute its Episode ID
 *     (fresh, collision-free sequence) — used for occasional admin fixes.
 * Returns 409 on a bookingCode collision.
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
    const programByEpisode = (body?.programByEpisode && typeof body.programByEpisode === 'object')
      ? body.programByEpisode as Record<string, string>
      : null

    // ── REPROGRAM mode: change an episode's show/program, recompute its ID ──
    if (programByEpisode && Object.keys(programByEpisode).length > 0) {
      const plan = await planReprogram(params.id, programByEpisode)
      if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 })
      const result = await regenerateBookingId({
        bookingId: params.id,
        newBookingCode: plan.newBookingCode,
        episodeChanges: plan.episodeChanges.map(c => ({ episodeDbId: c.episodeDbId, newEpisodeId: c.newEpisodeId })),
        programUpdates: plan.programUpdates.map(p => ({ episodeDbId: p.episodeDbId, programId: p.programId, programCode: p.programCode, programName: p.programName })),
        actorEmail: session.email,
        dryRun,
        notifyCalendar,
      })
      if (!result.ok) return NextResponse.json({ error: result.error || 'Reprogram failed', result }, { status: 409 })
      return NextResponse.json({ ok: true, mode: 'reprogram', result })
    }

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
