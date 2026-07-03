import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runVideoMerge } from '@/lib/video-merge'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // walking + moving footage across folders can take a while

/**
 * v1.109 — Internal endpoint. MOVES NAS footage from the flat "Production Team"
 * landing folders into each booking's VIDEO 2026 box, keyed by Production ID,
 * mirroring the camera/EP subfolder tree. Auth: shared secret header
 * (x-video-merge-secret) or admin session — same pattern as sound-merge.
 *
 * GET /api/internal/video-merge/run[?dryRun=1]
 */
function expectedSecret(): string | undefined {
  return process.env.VIDEO_MERGE_SECRET?.trim()
    || process.env.SOUND_MERGE_SECRET?.trim()
    || process.env.NAS_MANIFEST_SECRET?.trim() // v1.113.4 — the NAS agent's shared secret may trigger merges (same trust domain: the admin Mac)
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-video-merge-secret')?.trim()
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
  const onlyCode = searchParams.get('code')?.trim() || undefined
  try {
    const result = await runVideoMerge({ dryRun, onlyCode })
    if (!dryRun) await recordHeartbeat('video-merge').catch(() => {})
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/video-merge/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
