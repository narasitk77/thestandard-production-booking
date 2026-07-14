import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runFootageReadyScan } from '@/lib/footage-ready'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // fresh Drive walks for up to FOOTAGE_READY_MAX_PER_RUN bookings

// Same reentrancy guard as the other Drive-walking internal routes: two
// overlapping sweeps would double-walk (and in the worst case double-send
// inside the stamp race window). dryRun reads are never gated.
let footageReadyRunning = false

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

  if (!dryRun) {
    if (footageReadyRunning) {
      return NextResponse.json({ error: 'footage-ready sweep กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    }
    footageReadyRunning = true
  }
  try {
    const result = await runFootageReadyScan({ dryRun })
    if (!dryRun) await recordHeartbeat('footage-ready').catch(() => {})
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/footage-ready/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  } finally {
    if (!dryRun) footageReadyRunning = false
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
