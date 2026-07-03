import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runSoundMerge } from '@/lib/sound-merge'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // copying audio across folders can take a while

/**
 * v1.108 — Internal worker endpoint, poked hourly by scripts/sound-merge-worker.js.
 * Copies staged audio (_SOUND-STAGING/<Production ID>/) into each booking's video
 * box AUDIO folder. Auth: shared secret header (x-sound-merge-secret) or admin
 * session — same pattern as /api/internal/footage/sync.
 *
 * GET /api/internal/sound-merge/run[?dryRun=1]
 */
function expectedSecret(): string | undefined {
  return process.env.SOUND_MERGE_SECRET?.trim()
    || process.env.NAS_MANIFEST_SECRET?.trim() // v1.113.4 — the NAS agent's shared secret may trigger merges (same trust domain: the admin Mac)
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-sound-merge-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  try {
    const result = await runSoundMerge({ dryRun })
    if (!dryRun) await recordHeartbeat('sound-merge')
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[sound-merge] route error:', e)
    return NextResponse.json({ ok: false, reason: e?.message || String(e) }, { status: 500 })
  }
}
