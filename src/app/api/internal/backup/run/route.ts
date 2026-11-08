import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { runBackup } from '@/lib/backup'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'

/**
 * Internal worker endpoint — poked daily by scripts/backup-worker.js. Same auth
 * shape as the other internal endpoints: a shared secret header or an admin
 * session. GET /api/internal/backup/run
 */
// 2026-11-08 — ANY configured secret, not the first-set chain (internal-auth.ts v1.123):
// `X || NEXTAUTH || AUTH` + `===` 401'd every caller still sending NEXTAUTH the day X was set.
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-backup-secret',
    ['BACKUP_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runBackup()
    await recordHeartbeat('backup', `${result.fileName} (${Math.round(result.sizeBytes / 1024)}KB)`)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[backup] route error:', e)
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
