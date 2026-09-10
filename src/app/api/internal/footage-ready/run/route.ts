import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runFootageReadyScan, parseForcedCodes } from '@/lib/footage-ready'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // fresh Drive walks for up to FOOTAGE_READY_MAX_PER_RUN bookings

// Same reentrancy guard as the other Drive-walking internal routes: two
// overlapping sweeps would double-walk (and in the worst case double-send
// inside the stamp race window). dryRun reads are never gated.
//
// v1.220 — TIMESTAMP, not a boolean. This is the identical fix landing/manage
// took in v1.149, and footage-ready was left on the old shape. A boolean is
// only cleared in `finally`, so a request that never settles — a Drive call
// that hangs with no timeout — latches it for the life of the process and every
// later sweep 409s forever. That is not hypothetical: this route stopped
// ticking on 2026-09-04 and then answered 38 × HTTP 409 in 24h while 16
// finished shoots went un-walked and nobody was told their footage was ready.
// A stale latch must expire on its own.
let footageReadyRunningSince: number | null = null
const FOOTAGE_READY_GUARD_MAX_MS = 15 * 60 * 1000

/**
 * GET /api/internal/footage-ready/run[?dryRun=1]
 *
 * v1.147 — auto "footage ready" sweep (see src/lib/footage-ready.ts for the
 * readiness definition). Poked by scripts/footage-ready-worker.js every
 * FOOTAGE_READY_INTERVAL_MS; also runnable by an ADMIN for a manual sweep.
 * dryRun returns the would-notify candidates with zero writes/sends.
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-footage-ready-secret',
    ['FOOTAGE_READY_SECRET', 'REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  // ?codes=A,B — notify these bookings even though they fell out of the lookback
  // window (the headless equivalent of pressing 📣). See parseForcedCodes.
  const codes = parseForcedCodes(searchParams.get('codes'))

  if (!dryRun) {
    if (footageReadyRunningSince && Date.now() - footageReadyRunningSince < FOOTAGE_READY_GUARD_MAX_MS) {
      return NextResponse.json({ error: 'footage-ready sweep กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    }
    footageReadyRunningSince = Date.now()
  }
  try {
    const result = await runFootageReadyScan({ dryRun, codes })
    // A forced one-off must not stand in for the scheduled sweep's heartbeat —
    // that would make the dead-man switch report a worker that never ran.
    if (!dryRun && codes.length === 0) await recordHeartbeat('footage-ready').catch(() => {})
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/footage-ready/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  } finally {
    if (!dryRun) footageReadyRunningSince = null
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
