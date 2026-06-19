import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runBackup } from '@/lib/backup'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'

/**
 * Internal worker endpoint — poked daily by scripts/backup-worker.js. Same auth
 * shape as the other internal endpoints: a shared secret header or an admin
 * session. GET /api/internal/backup/run
 */
function expectedSecret(): string | undefined {
  return process.env.BACKUP_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-backup-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return true
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
