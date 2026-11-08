import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runFootageSync } from '@/lib/footage-sync'
import { recordHeartbeat } from '@/lib/heartbeat'
import { runGuard, MERGE_LOCK_MAX_MS } from '@/lib/merge-lock'

export const dynamic = 'force-dynamic'

// v1.146 review fix — same reentrancy guard as video-merge/sound-merge: a
// proxy-timeout-driven retry must not overlap two real (non-dryRun) passes,
// since the underlying Drive folder primitives are non-atomic.
// maint 2026-11-08 — the guard EXPIRES (a boolean latched forever on one hung Drive/Sheets call; see runGuard), but
// only after MERGE_LOCK_MAX_MS: hang recovery, never an overlap of a slow live pass (that would append sheet rows twice).
const guard = runGuard('footage-sync', MERGE_LOCK_MAX_MS)

/**
 * Internal worker endpoint — poked every FOOTAGE_WORKER_INTERVAL_MS by
 * `scripts/footage-sheet-sync-worker.js`. Mirrors the
 * `/api/internal/calendar/reconcile` auth pattern: accept either a
 * shared secret header (`x-footage-sync-secret`) or an admin session.
 *
 * GET /api/internal/footage/sync[?dryRun=1]
 */

function expectedSecret(): string | undefined {
  return process.env.FOOTAGE_SYNC_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-footage-sync-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return { ok: true, isWorker: true }

  const session = await getSession()
  return { ok: session?.role === 'ADMIN', isWorker: false }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'

  let token = 0
  if (!dryRun) {
    token = guard.start()
    if (!token) return NextResponse.json({ ok: false, reason: 'footage-sync กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
  }
  try {
    const result = await runFootageSync({ dryRun })
    // maint 2026-11-08 — heartbeat = the scheduled sweep ran and could do its job (the video/sound/prep rule): `reason`
    // is set only when the run stopped before syncing anything (env unset / sheet probe / Drive list failed), and an
    // admin click must not stand in for a dead worker (shoot-markers rule).
    if (!dryRun && result.reason) console.error(`[footage-sync] run failed: ${result.reason}`)
    if (allowed.isWorker && !dryRun && !result.reason) await recordHeartbeat('footage')
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[footage-sync] route error:', e)
    return NextResponse.json({ ok: false, reason: e?.message || String(e) }, { status: 500 })
  } finally {
    if (token) guard.end(token)
  }
}
