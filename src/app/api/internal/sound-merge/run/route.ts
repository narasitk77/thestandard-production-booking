import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runSoundMerge } from '@/lib/sound-merge'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // copying audio across folders can take a while

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
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-sound-merge-secret',
    ['SOUND_MERGE_SECRET', 'NAS_MANIFEST_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  const onlyCode = searchParams.get('code')?.trim() || undefined
  try {
    const result = await runSoundMerge({ dryRun, onlyCode })
    if (!dryRun) await recordHeartbeat('sound-merge')
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[sound-merge] route error:', e)
    return NextResponse.json({ ok: false, reason: e?.message || String(e) }, { status: 500 })
  }
}
