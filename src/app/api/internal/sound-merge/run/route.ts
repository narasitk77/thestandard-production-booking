import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runSoundMerge } from '@/lib/sound-merge'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { runGuard, MERGE_LOCK_MAX_MS } from '@/lib/merge-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // copying audio across folders can take a while

// v1.146 review fix — same reentrancy guard as video-merge/sound-staging-restructure:
// a proxy-timeout-driven retry must not overlap two real (non-dryRun) passes,
// since the underlying Drive folder primitives are non-atomic.
// maint 2026-11-08 — the guard EXPIRES (a boolean latched forever on one hung Drive call; see runGuard), but only
// after MERGE_LOCK_MAX_MS: hang recovery, never an overlap of a slow live pass.
const guard = runGuard('sound-merge', MERGE_LOCK_MAX_MS)

/**
 * v1.108 — Internal worker endpoint, poked hourly by scripts/sound-merge-worker.js.
 * Copies staged audio (_SOUND-STAGING/<Production ID>/) into each booking's video
 * box AUDIO folder. Auth: shared secret header (x-sound-merge-secret) or admin
 * session — same pattern as /api/internal/footage/sync.
 *
 * v1.123 — accept ANY configured secret (internalSecretAllowed): the old
 * first-set-env-wins equality broke against the worker after v1.113.4 put
 * NAS_MANIFEST_SECRET ahead of the NEXTAUTH_SECRET the worker sends → the
 * hourly merge 401'd silently.
 *
 * GET /api/internal/sound-merge/run[?dryRun=1]
 */
async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  if (internalSecretAllowed(request, 'x-sound-merge-secret',
    ['SOUND_MERGE_SECRET', 'NAS_MANIFEST_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return { ok: true, isWorker: true }
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
  const onlyCode = searchParams.get('code')?.trim() || undefined

  let token = 0
  if (!dryRun) {
    token = guard.start()
    if (!token) return NextResponse.json({ ok: false, reason: 'sound-merge กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
  }
  try {
    const result = await runSoundMerge({ dryRun, onlyCode })
    // maint 2026-11-08 — heartbeat = the scheduled sweep ran and could do its job: not a skipped run (no
    // _SOUND-STAGING / env unset = nothing merged), not a ?code= one-off, not an admin click (shoot-markers rule).
    if (!dryRun && result.skipped) console.error(`[sound-merge] run failed: skipped — ${result.reason}`)
    if (allowed.isWorker && !dryRun && !onlyCode && !result.skipped) await recordHeartbeat('sound-merge')
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[sound-merge] route error:', e)
    return NextResponse.json({ ok: false, reason: e?.message || String(e) }, { status: 500 })
  } finally {
    if (token) guard.end(token)
  }
}
