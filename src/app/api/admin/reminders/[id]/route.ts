import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/reminders/[id] — dismiss or resolve a reminder.
 * Body: { status: 'DISMISSED' | 'RESOLVED' | 'PENDING' }
 *
 * DISMISSED = silence it (won't re-appear in the digest). RESOLVED = handled.
 * The daily scan auto-resolves reminders whose condition clears, so this is for
 * manual override (e.g. "I know, stop reminding me").
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const next = String(body.status || '').toUpperCase()
  if (!['DISMISSED', 'RESOLVED', 'PENDING'].includes(next)) {
    return NextResponse.json({ error: 'status must be DISMISSED, RESOLVED, or PENDING' }, { status: 400 })
  }
  try {
    const before = await prisma.reminder.findUnique({ where: { id: params.id } })
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const reminder = await prisma.reminder.update({
      where: { id: params.id },
      data: {
        status: next as any,
        resolvedAt: next === 'RESOLVED' ? new Date() : next === 'PENDING' ? null : undefined,
      },
    })
    logAudit({
      actorEmail: session.email,
      action: 'reminder.update',
      entityType: 'Reminder',
      entityId: params.id,
      fromStatus: before.status,
      toStatus: next,
    })
    return NextResponse.json({ reminder })
  } catch (e: any) {
    console.error('PATCH /api/admin/reminders/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
