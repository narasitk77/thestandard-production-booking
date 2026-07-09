import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { prepTodayShootFolders } from '@/lib/prep-folders'

export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/prep-folders/run[?dryRun=1]
 *
 * v1.86 — pre-create the Drive boxes for today's shoots. Hit by the
 * prep-folders worker hourly; also runnable by an ADMIN for a manual sweep.
 * Secret reuses NEXTAUTH_SECRET (same shape as /api/internal/reminders/run).
 */
function expectedSecret(): string | undefined {
  return process.env.PREP_FOLDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-prep-folders-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === '1'
  // v1.137 — ?days=N: one-time catch-up that re-ensures landing drop folders for
  // shoots in the last N days (restores folders the old cleanup trashed). Omit for
  // the normal today-only sweep the hourly worker runs.
  const catchupDays = url.searchParams.get('days') ? Math.max(0, Number(url.searchParams.get('days'))) : 0
  try {
    const result = await prepTodayShootFolders({ dryRun, catchupDays })
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/prep-folders/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
