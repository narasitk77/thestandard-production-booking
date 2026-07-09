import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { reconcileShootMarkers, formatReconcileReport, totalChanges } from '@/lib/shoot-marker-reconcile'
import { sendEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/shoot-markers/reconcile?dryRun=1&projectId=&limit=&report=1
 *
 * v1.135 — enforce "one _SHOOT marker per booking"; v1.136 — also audit marker
 * CONTENT (Production ID + Gregorian date) against the DB and rewrite on drift,
 * then email a digest. Same auth shape as the calendar reconcile: the supervised
 * nightly worker sends the shared secret header; an ADMIN session may also trigger
 * it (dry-run) from the browser. dryRun defaults TRUE — a mutating run must pass
 * dryRun=0. `report=1` forces the email even from a dry-run/admin trigger.
 */
function expectedSecret(): string | undefined {
  return process.env.SHOOT_MARKER_RECONCILE_SECRET?.trim()
    || process.env.CALENDAR_RECONCILE_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

function reportEmail(): string {
  return process.env.SHOOT_MARKER_REPORT_EMAIL?.trim()
    || process.env.FEEDBACK_EMAIL?.trim()
    || 'narasit.k@thestandard.co'
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actorEmail: string | null; isWorker: boolean }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reconcile-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) {
    return { ok: true, actorEmail: 'shoot-marker-worker', isWorker: true }
  }
  const session = await getSession()
  if (session?.role === 'ADMIN') return { ok: true, actorEmail: session.email, isWorker: false }
  return { ok: false, actorEmail: null, isWorker: false }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dryRunParam = searchParams.get('dryRun')
  const dryRun = !(dryRunParam === '0' || dryRunParam === 'false')
  const projectId = searchParams.get('projectId')?.trim() || undefined
  const limitProjects = searchParams.get('limit') ? Math.max(1, Number(searchParams.get('limit'))) : undefined
  const forceReport = searchParams.get('report') === '1'

  try {
    const result = await reconcileShootMarkers({ dryRun, projectId, limitProjects })
    const changes = totalChanges(result)

    if (!dryRun && changes > 0) {
      logAudit({
        actorEmail: allowed.actorEmail || 'shoot-marker-worker',
        action: 'drive.reconcile_shoot_markers',
        entityType: 'Drive',
        entityId: projectId || 'all-agn',
        changes: { ...result.fixed, warnings: result.warnings.length, errors: result.errors, scannedBookings: result.scannedBookings },
      })
    }

    // Nightly digest email. Default: email only when there's something worth
    // seeing (changes / warnings / errors) so a clean night is silent — the
    // worker path (isWorker) opts into this; `report=1` forces it either way.
    const worthEmailing = changes > 0 || result.warnings.length > 0 || result.errors > 0
    if ((allowed.isWorker && worthEmailing) || forceReport) {
      try {
        const { subject, text } = formatReconcileReport(result)
        await sendEmail({
          to: reportEmail(),
          subject,
          text,
          html: text.replace(/\n/g, '<br>').replace(/────+/g, '<hr>'),
        })
      } catch (e: any) {
        console.error('[shoot-markers] report email failed (non-fatal):', e?.message || e)
      }
    }

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/shoot-markers/reconcile error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
