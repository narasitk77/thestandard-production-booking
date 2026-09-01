/**
 * GET /api/internal/lark-export/stats
 *
 * v1.212 — read-only outcome of the Lark export, for the nightly check and for
 * an admin eyeballing it. `/api/health-summary` answers "did the worker tick";
 * this answers "did last night's snapshot actually land in Lark, and what
 * disappeared from the database since the night before".
 *
 * No writes, no Lark calls. Safe to poll.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { larkExportStats } from '@/lib/lark-export'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const allowed =
    internalSecretAllowed(request, 'x-lark-export-secret',
      ['LARK_EXPORT_SECRET', 'BACKUP_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']) ||
    (await getSession())?.role === 'ADMIN'
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    return NextResponse.json(await larkExportStats())
  } catch (e: any) {
    console.error('[lark-export] stats error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
