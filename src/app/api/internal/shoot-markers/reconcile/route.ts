import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { reconcileShootMarkers } from '@/lib/shoot-marker-reconcile'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/shoot-markers/reconcile?dryRun=1&projectId=&limit=
 *
 * v1.135 — enforce "one _SHOOT marker per booking" across AGN project boxes
 * (trash pre-migration box-level duplicates that make the footage crawler file
 * two cards per shoot — Neo memo 2026-07-09 item 3). Same auth shape as the
 * calendar reconcile: the supervised worker sends the shared secret header;
 * an ADMIN session may also trigger it (dry-run) from the browser.
 *
 * dryRun defaults to TRUE — a mutating run must pass dryRun=0 explicitly.
 */
function expectedSecret(): string | undefined {
  return process.env.SHOOT_MARKER_RECONCILE_SECRET?.trim()
    || process.env.CALENDAR_RECONCILE_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actorEmail: string | null }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reconcile-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) {
    return { ok: true, actorEmail: 'shoot-marker-worker' }
  }
  const session = await getSession()
  if (session?.role === 'ADMIN') return { ok: true, actorEmail: session.email }
  return { ok: false, actorEmail: null }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  // dryRun is the DEFAULT — only an explicit dryRun=0/false mutates Drive.
  const dryRunParam = searchParams.get('dryRun')
  const dryRun = !(dryRunParam === '0' || dryRunParam === 'false')
  const projectId = searchParams.get('projectId')?.trim() || undefined
  const limitProjects = searchParams.get('limit') ? Math.max(1, Number(searchParams.get('limit'))) : undefined

  try {
    const result = await reconcileShootMarkers({ dryRun, projectId, limitProjects })

    // Audit only real mutations (an apply run that actually changed Drive).
    const changed = result.trashedDuplicates + result.movedIntoBooking + result.trashedStale + result.dedupedInSubfolder
    if (!dryRun && changed > 0) {
      logAudit({
        actorEmail: allowed.actorEmail || 'shoot-marker-worker',
        action: 'drive.reconcile_shoot_markers',
        entityType: 'Drive',
        entityId: projectId || 'all-agn',
        changes: {
          projects: result.projects,
          trashedDuplicates: result.trashedDuplicates,
          movedIntoBooking: result.movedIntoBooking,
          trashedStale: result.trashedStale,
          dedupedInSubfolder: result.dedupedInSubfolder,
          errors: result.errors,
        },
      })
    }

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/shoot-markers/reconcile error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
