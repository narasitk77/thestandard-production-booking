import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { reconcileCalendarGuests } from '@/lib/calendar-reconcile'
import { recordHeartbeat, maybeAlertStaleWorkers } from '@/lib/heartbeat'
import { alertOps } from '@/lib/ops-alert'

export const dynamic = 'force-dynamic'

// 2026-11-08 — ANY configured secret, not the first-set chain (internal-auth.ts v1.123):
// `X || NEXTAUTH || AUTH` + `===` 401'd every caller still sending NEXTAUTH the day X was set.
async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actorEmail: string | null }> {
  if (internalSecretAllowed(request, 'x-reconcile-secret',
    ['CALENDAR_RECONCILE_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) {
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
  // v1.185.2 — default 50 → 200 (เท่าเพดานใน reconcileCalendarGuests). ที่ 50
  // งาน CONFIRMED ใบที่ 51 ขึ้นไปไม่เคยถูก reconcile เลย เพราะ orderBy shootDate asc
  // ทำให้ลำดับคงที่ทุกรอบ ไม่ใช่ "รอบหน้าค่อยถึง" (prod มี 62 ใบตอนเจอปัญหา)
  const limit = Number(searchParams.get('limit') || 200)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'

  // Dead-man check for every OTHER worker FIRST and on its own (2026-11-08). It
  // used to run only after the Calendar pass succeeded, so a pass that threw or
  // hung on a Google socket (google-calendar.ts has no timeout) switched off the
  // in-app alarm for all 16 workers. Run first, a hung pass still gets caught:
  // our own heartbeat goes stale and the next tick's check reports it.
  if (!dryRun) {
    try {
      await maybeAlertStaleWorkers()
    } catch (e: any) {
      console.error('[calendar-reconcile] route error: dead-man check failed:', e?.message || e)
    }
  }

  try {
    const result = await reconcileCalendarGuests({
      limit,
      dryRun,
      actorEmail: allowed.actorEmail,
    })
    if (!dryRun) {
      // The truncated flag needs a READER (bug class 7): the order is fixed
      // (shootDate asc), so the jobs past the cap are never reached, not "next run".
      await recordHeartbeat('calendar-reconcile', result.truncated ? `TRUNCATED checked=${result.checked}` : undefined)
      if (result.truncated) {
        await alertOps('calendar-reconcile-truncated',
          `⚠️ Calendar reconcile ตรวจไม่ครบ — ชนเพดาน ${result.checked} ใบ`,
          `calendar reconcile ชนเพดาน ${result.checked} ใบ (limit=${limit}) — งาน CONFIRMED ที่วันถ่ายไกลกว่านี้ไม่ถูกตรวจเลย ` +
          `(เรียง shootDate คงที่ทุกรอบ จึงไม่ใช่ว่ารอบหน้าจะถึง) · ขยาย ?limit= ใน scripts/calendar-reconcile-worker.js ` +
          `และเพดานใน reconcileCalendarGuests`)
      }
    }
    return NextResponse.json({ success: true, dryRun, ...result })
  } catch (e: any) {
    console.error('GET /api/internal/calendar/reconcile error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
