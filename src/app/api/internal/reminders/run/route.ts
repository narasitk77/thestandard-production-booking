import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runReminderScan } from '@/lib/reminders'

export const dynamic = 'force-dynamic'

function expectedSecret(): string | undefined {
  return process.env.REMINDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reminders-secret')?.trim()
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
    const result = await runReminderScan({ dryRun })
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/reminders/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
