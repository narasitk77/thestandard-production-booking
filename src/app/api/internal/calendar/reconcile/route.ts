import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { reconcileCalendarGuests } from '@/lib/calendar-reconcile'

export const dynamic = 'force-dynamic'

function expectedSecret(): string | undefined {
  return process.env.CALENDAR_RECONCILE_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actorEmail: string | null }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reconcile-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) {
    return { ok: true, actorEmail: 'calendar-reconcile-worker' }
  }

  const session = await getSession()
  if (session?.role === 'ADMIN') {
    return { ok: true, actorEmail: session.email }
  }

  return { ok: false, actorEmail: null }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Number(searchParams.get('limit') || 50)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'

  try {
    const result = await reconcileCalendarGuests({
      limit,
      dryRun,
      actorEmail: allowed.actorEmail,
    })
    return NextResponse.json({ success: true, dryRun, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/calendar/reconcile error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
