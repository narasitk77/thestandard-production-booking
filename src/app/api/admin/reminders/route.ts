import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { runReminderScan } from '@/lib/reminders'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/reminders — list reminders (open by default).
 * Query: ?status=open|all|PENDING|SENT|DISMISSED|RESOLVED
 */
export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const status = (new URL(request.url).searchParams.get('status') || 'open').toUpperCase()
  const where =
    status === 'ALL'
      ? {}
      : status === 'OPEN'
        ? { status: { in: ['PENDING', 'SENT'] as const } }
        : { status: status as any }

  const reminders = await prisma.reminder.findMany({
    where,
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
  })
  return NextResponse.json({ reminders })
}

/**
 * POST /api/admin/reminders — manually trigger a scan (dryRun optional).
 * Body: { dryRun?: boolean }
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  try {
    const result = await runReminderScan({ dryRun: !!body.dryRun })
    if (!body.dryRun) {
      logAudit({ actorEmail: session.email, action: 'reminder.scan', entityType: 'Reminder', changes: result })
    }
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('POST /api/admin/reminders error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
