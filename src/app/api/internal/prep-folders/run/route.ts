import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { prepTodayShootFolders } from '@/lib/prep-folders'
import { recordHeartbeat } from '@/lib/heartbeat'
import { runGuard, MERGE_LOCK_MAX_MS } from '@/lib/merge-lock'

export const dynamic = 'force-dynamic'

// v1.146 review fix — same reentrancy guard as video-merge/sound-merge: a
// proxy-timeout-driven retry must not overlap two real (non-dryRun) passes,
// since the underlying Drive folder primitives are non-atomic.
// maint 2026-11-08 — the guard EXPIRES (a boolean latched forever on one hung Drive call; see runGuard), but only
// after MERGE_LOCK_MAX_MS: hang recovery, never an overlap of a slow live pass (the folder creates are non-atomic).
const guard = runGuard('prep-folders', MERGE_LOCK_MAX_MS)

/**
 * GET /api/internal/prep-folders/run[?dryRun=1]
 *
 * v1.86 — pre-create the Drive boxes for today's shoots. Hit by the
 * prep-folders worker hourly; also runnable by an ADMIN for a manual sweep.
 * Secret reuses NEXTAUTH_SECRET (same shape as /api/internal/reminders/run).
 */
function expectedSecret(): string | undefined {
  return process.env.PREP_FOLDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-prep-folders-secret')?.trim()
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
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'

  let token = 0
  if (!dryRun) {
    token = guard.start()
    if (!token) return NextResponse.json({ success: false, error: 'prep-folders กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
  }
  try {
    const result = await prepTodayShootFolders({ dryRun })
    // maint 2026-11-08 — heartbeat = the scheduled sweep ran and could do its job: not a skipped run (env unset =
    // nothing prepped), not an admin's manual sweep standing in for a dead worker (shoot-markers rule).
    if (!dryRun && result.skipped) console.error(`[prep-folders] run failed: skipped — ${result.reason}`)
    if (allowed.isWorker && !dryRun && !result.skipped) await recordHeartbeat('prep-folders')
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/prep-folders/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  } finally {
    if (token) guard.end(token)
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
