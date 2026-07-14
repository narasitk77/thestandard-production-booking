import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { dedupeLandingFolders } from '@/lib/landing-dedup'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// v1.146 review fix — same reentrancy guard as video-merge/sound-merge: a
// proxy-timeout-driven retry must not overlap two real (non-dryRun) passes,
// since the underlying Drive folder primitives are non-atomic.
let landingDedupRunning = false

/**
 * GET /api/internal/landing-dedup/run[?dryRun=1]
 *
 * v1.138 — keep one landing drop folder per shoot on the Production Team drive,
 * trashing empty duplicate shells (a concurrent prep double-run created twins).
 * ADMIN session, or the shared secret header (same shape as the other internal
 * reconcilers). dryRun defaults TRUE — pass dryRun=0 to actually trash.
 */
function expectedSecret(): string | undefined {
  return process.env.PREP_FOLDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actor: string | null }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reconcile-secret')?.trim() || request.headers.get('x-prep-folders-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return { ok: true, actor: 'landing-dedup-worker' }
  const session = await getSession()
  if (session?.role === 'ADMIN') return { ok: true, actor: session.email }
  return { ok: false, actor: null }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const dryRunParam = new URL(request.url).searchParams.get('dryRun')
  const dryRun = !(dryRunParam === '0' || dryRunParam === 'false')

  if (!dryRun) {
    if (landingDedupRunning) {
      return NextResponse.json({ error: 'landing-dedup กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    }
    landingDedupRunning = true
  }
  try {
    const result = await dedupeLandingFolders({ dryRun })
    if (!dryRun && (result.trashed > 0 || result.errors > 0)) {
      logAudit({
        actorEmail: allowed.actor || 'landing-dedup',
        action: 'drive.dedupe_landing_folders',
        entityType: 'Drive',
        entityId: 'production-team',
        changes: { trashed: result.trashed, groupsWithDuplicates: result.groupsWithDuplicates, collisions: result.collisions.length, errors: result.errors },
      })
    }
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/landing-dedup/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  } finally {
    if (!dryRun) landingDedupRunning = false
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
