/**
 * POST /api/admin/:id/move-outlet — v1.163. ย้ายสังกัด (cross-outlet move).
 *
 * Deliberately NOT a third mode on /regenerate-id: that route's dryRun defaults
 * to FALSE (a trap for an operation this destructive) and its maxDuration is too
 * short for a move + staging relocation + marker rewrite.
 *
 * The contract is preview-then-apply:
 *   { targetOutlet, programByEpisode? }                    → dry-run plan
 *   { …, dryRun: false, expectedOldCode: "<current ID>" }  → apply
 * `expectedOldCode` is the replay guard. It covers both a second admin acting
 * concurrently and the far more likely case: the proxy 504s on this long call,
 * the operator re-clicks, and the first run already succeeded.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { planOutletMove, moveOutletEnabled } from '@/lib/move-outlet'
import { regenerateBookingId } from '@/lib/regenerate-booking-id'
import { clearFootageCache } from '@/lib/footage-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  if (!moveOutletEnabled()) {
    return NextResponse.json({ error: 'ปิดใช้งานชั่วคราว (MOVE_OUTLET_ENABLED=0)' }, { status: 503 })
  }

  const body = await request.json().catch(() => ({} as any))
  const targetOutlet = String(body?.targetOutlet || '').trim().toUpperCase()
  if (!targetOutlet) return NextResponse.json({ error: 'ต้องเลือกสังกัดปลายทาง' }, { status: 400 })

  // Inverted default ON PURPOSE — an apply must be explicit.
  const dryRun = body?.dryRun !== false

  const plan = await planOutletMove({
    bookingId: params.id,
    targetOutletCode: targetOutlet,
    programByEpisodeDbId: body?.programByEpisode ?? {},
    dryRun,
  })
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 })
  if (dryRun) return NextResponse.json({ ok: true, mode: 'dry-run', plan })

  if (body?.expectedOldCode !== plan.oldBookingCode) {
    return NextResponse.json({
      error: `เลข ID เปลี่ยนไปแล้ว (ตอนนี้คือ ${plan.oldBookingCode}) — กด "ดูก่อน" ใหม่อีกครั้งก่อนย้าย`,
    }, { status: 409 })
  }

  const result = await regenerateBookingId({
    bookingId: params.id,
    newBookingCode: plan.newBookingCode,
    episodeChanges: plan.episodeChanges.map(c => ({ episodeDbId: c.episodeDbId, newEpisodeId: c.newEpisodeId })),
    programUpdates: plan.programUpdates,
    outletMove: {
      outletId: plan.outletUpdate.outletId,
      outletCode: plan.outletUpdate.outletCode,
      outletName: plan.outletUpdate.outletName,
      bookingProgramId: plan.outletUpdate.bookingProgramId,
      bookingProgramCode: plan.outletUpdate.bookingProgramCode,
      bookingProgramName: plan.outletUpdate.bookingProgramName,
    },
    actorEmail: session.email,
    dryRun: false,
    // An outlet fix is not a schedule change — never spam the crew's calendars.
    notifyCalendar: body?.notifyCalendar === true,
  })
  if (!result.ok) return NextResponse.json({ error: result.error, plan, result }, { status: 409 })

  // The cache keys footage by the old code/path; drop it so the next read is fresh.
  // NOTE: deliberately NOT syncBookingOT — that is deleteMany + recreate, and it
  // would destroy approved OT records along with their snapshotted signatures.
  await clearFootageCache(params.id).catch(() => {})

  return NextResponse.json({ ok: true, mode: 'applied', plan, result })
}
