import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { scanFootageIntegrity, formatFootageIntegrityReport } from '@/lib/footage-integrity'
import { notifyChat } from '@/lib/notify'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/footage-integrity/run[?days=30&limit=60&codes=A,B&quiet=1]
 *
 * v1.221 — the "is the footage any good?" pass. Read-only by construction:
 * there is no dryRun flag because there is nothing to apply. See
 * src/lib/footage-integrity.ts for why repair is deliberately not automated.
 *
 * Auth uses internalSecretAllowed (accepts ANY configured secret) rather than
 * the older `A || B || C` single-chain style. That chain is what silently 401'd
 * the landing cron for 13 days after a NEXTAUTH_SECRET rotation — a new route
 * should not inherit that trap.
 */
async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  if (internalSecretAllowed(request, 'x-footage-integrity-secret',
    ['REMINDERS_SECRET', 'PREP_FOLDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) {
    return { ok: true, isWorker: true }
  }
  const session = await getSession()
  return { ok: session?.role === 'ADMIN', isWorker: false }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const days = url.searchParams.get('days') != null ? Number(url.searchParams.get('days')) : undefined
  const limit = url.searchParams.get('limit') != null ? Number(url.searchParams.get('limit')) : undefined
  const codes = (url.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean)
  // An admin poking this by hand should be able to look without paging the team.
  const quiet = url.searchParams.get('quiet') === '1'

  try {
    const r = await scanFootageIntegrity({ days, limit, codes: codes.length ? codes : undefined })

    if (allowed.isWorker) await recordHeartbeat('footage-integrity', `${r.withIssues}/${r.scanned}`)

    const text = formatFootageIntegrityReport(r)
    if (text && !quiet && allowed.isWorker) {
      try { await notifyChat(text, 'footage') }
      catch (e: any) { console.error('[footage-integrity] notify failed (non-fatal):', e?.message || e) }
    }
    return NextResponse.json({ success: true, ...r, report: text || null })
  } catch (e: any) {
    console.error('GET /api/internal/footage-integrity/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
