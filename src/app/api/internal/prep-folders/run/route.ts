import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { prepTodayShootFolders } from '@/lib/prep-folders'

export const dynamic = 'force-dynamic'

// v1.146 review fix — same reentrancy guard as video-merge/sound-merge: a
// proxy-timeout-driven retry must not overlap two real (non-dryRun) passes,
// since the underlying Drive folder primitives are non-atomic.
let prepFoldersRunning = false

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
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'

  if (!dryRun) {
    if (prepFoldersRunning) {
      return NextResponse.json({ success: false, error: 'prep-folders กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    }
    prepFoldersRunning = true
  }
  try {
    const result = await prepTodayShootFolders({ dryRun })
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/prep-folders/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  } finally {
    if (!dryRun) prepFoldersRunning = false
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
