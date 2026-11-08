import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { runReminderScan } from '@/lib/reminders'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'

// 2026-11-08 — ANY configured secret, not the first-set chain (internal-auth.ts v1.123):
// `X || NEXTAUTH || AUTH` + `===` 401'd every caller still sending NEXTAUTH the day X was set.
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-reminders-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true

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
    if (!dryRun) await recordHeartbeat('reminders')
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/reminders/run error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
