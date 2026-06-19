import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runFootageSync } from '@/lib/footage-sync'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'

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

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-footage-sync-secret')?.trim()
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
    const result = await runFootageSync({ dryRun })
    if (!dryRun) await recordHeartbeat('footage')
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[footage-sync] route error:', e)
    return NextResponse.json({ ok: false, reason: e?.message || String(e) }, { status: 500 })
  }
}
