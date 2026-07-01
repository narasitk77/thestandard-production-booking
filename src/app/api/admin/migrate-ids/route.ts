import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { planTypeDropMigration, regenerateBookingId, type MigrationPlanInput } from '@/lib/regenerate-booking-id'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/admin/migrate-ids   { apply?: boolean, notifyCalendar?: boolean }
 *
 * v1.109 one-off migration: drop the legacy [TYPE] segment from every booking's
 * Production/Episode ID. Default is a DRY RUN — returns the full plan (what would
 * change, which colliding pairs are skipped, any duplicate-episodeId warnings)
 * without touching anything. Pass { apply: true } to execute; each surviving
 * booking is regenerated via the shared primitive (DB + Drive + Sheet + Calendar).
 *
 * Idempotent: once a booking's code is type-less, the planner leaves it alone, so
 * re-running apply after a timeout only finishes the remainder.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const notifyCalendar = body?.notifyCalendar === true

    // Every booking that still has a code (deleted included — their folders/sheet
    // rows may still exist and should stay consistent). Episodes drive per-episode
    // renames + collision detection.
    const bookings = await prisma.booking.findMany({
      select: {
        id: true,
        bookingCode: true,
        episodes: { select: { id: true, episodeId: true } },
      },
    })

    const plan = planTypeDropMigration(bookings as MigrationPlanInput[])

    // Enrich the plan for human review (outlet + status per booking).
    const meta = new Map(
      (await prisma.booking.findMany({
        select: { id: true, status: true, deletedAt: true, outlet: { select: { code: true } } },
      })).map(b => [b.id, b]),
    )
    const describe = (bookingId: string) => {
      const m = meta.get(bookingId)
      return { outlet: m?.outlet?.code ?? null, status: m?.status ?? null, deleted: !!m?.deletedAt }
    }

    const summary = {
      totalBookings: bookings.length,
      toApplyCount: plan.toApply.length,
      collisionGroups: plan.collisions.length,
      collisionBookings: plan.collisions.reduce((n, c) => n + c.members.filter(m => m.wouldChange).length, 0),
      unchangedCount: plan.unchanged.length,
      episodeWarnings: plan.episodeIdWarnings.length,
    }

    if (!apply) {
      return NextResponse.json({
        dryRun: true,
        summary,
        toApply: plan.toApply.map(e => ({
          bookingId: e.bookingId,
          oldCode: e.oldCode,
          newCode: e.newCode,
          episodeChanges: e.episodeChanges.map(c => `${c.oldEpisodeId} → ${c.newEpisodeId}`),
          ...describe(e.bookingId),
        })),
        collisions: plan.collisions.map(c => ({
          finalCode: c.finalCode,
          members: c.members.map(m => ({ ...m, ...describe(m.bookingId) })),
        })),
        episodeIdWarnings: plan.episodeIdWarnings,
      })
    }

    // APPLY — sequential so we never race the @unique constraint or hammer the
    // Drive/Calendar APIs. Each result records exactly what cascaded.
    const results = []
    for (const entry of plan.toApply) {
      const r = await regenerateBookingId({
        bookingId: entry.bookingId,
        newBookingCode: entry.newCode,
        episodeChanges: entry.episodeChanges.map(c => ({ episodeDbId: c.episodeDbId, newEpisodeId: c.newEpisodeId })),
        actorEmail: session.email,
        notifyCalendar,
      })
      results.push({ oldCode: entry.oldCode, newCode: entry.newCode, ok: r.ok, error: r.error, effects: r.effects })
    }

    return NextResponse.json({
      dryRun: false,
      summary: { ...summary, applied: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length },
      results,
      collisionsSkipped: plan.collisions.map(c => ({ finalCode: c.finalCode, members: c.members.map(m => m.currentCode) })),
    })
  } catch (e: any) {
    console.error('POST /api/admin/migrate-ids error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
