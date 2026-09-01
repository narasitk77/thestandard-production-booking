/**
 * POST|GET /api/internal/lark-export/run[?dryRun=1]
 *
 * v1.212 — the daily export to Lark. Poked by scripts/lark-export-worker.js;
 * an admin can also run it by hand.
 *
 * `dryRun=1` reads the database, builds the snapshot and computes the tombstone
 * diff, then returns WITHOUT touching Lark and without writing a run row. That
 * is the safe way to see what a real run would ship — including exactly which
 * tables are excluded and why.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { runLarkExport, larkExportEnabled, heartbeatNote } from '@/lib/lark-export'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
// A first run creates every Base table and writes ~11k records; the default
// serverless-ish budget is nowhere near enough. The worker calls this over the
// compose network, so no reverse-proxy timeout applies.
export const maxDuration = 3600

const SECRET_ENVS = ['LARK_EXPORT_SECRET', 'BACKUP_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']

export async function POST(request: NextRequest) {
  const allowed =
    internalSecretAllowed(request, 'x-lark-export-secret', SECRET_ENVS) ||
    (await getSession())?.role === 'ADMIN'
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'

  // The enable flag is checked HERE as well as in the worker, so the endpoint
  // cannot ship data to Lark just because someone curled it. Same shape as
  // shoot-reviews/send: a dormant feature stays dormant from every direction.
  if (!dryRun && !larkExportEnabled()) {
    return NextResponse.json({ ok: false, skipped: true, reason: 'LARK_EXPORT_ENABLED is off' })
  }

  try {
    const result = await runLarkExport({ dryRun })

    // Liveness, not outcome: a real pass ran, so tick — even if the upload
    // failed. Whether the file LANDED is the job of
    // /api/internal/lark-export/stats, which says so in words. A dry run is a
    // rehearsal and must never make a dead nightly worker look alive.
    if (!dryRun) await recordHeartbeat('lark-export', heartbeatNote(result))

    // Trim the payload: the tombstone list can be long and the caller is a log
    // line. The full list is in the Base.
    return NextResponse.json({
      ...result,
      tombstones: result.tombstones.slice(0, 50),
      tombstoneCount: result.tombstones.length,
    })
  } catch (e: any) {
    console.error('[lark-export] route error:', e)
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
