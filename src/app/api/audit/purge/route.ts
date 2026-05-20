/**
 * POST /api/audit/purge
 *
 * Admin-only manual trigger for the retention purge. The same query runs
 * automatically at app startup (start.sh) — this endpoint exists so admins
 * can run it on demand without restarting the service.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin, getSession } from '@/lib/session'
import { RETENTION_DAYS } from '@/lib/audit-retention'
import { logAudit } from '@/lib/audit'

export async function POST(_request: NextRequest) {
  try {
    const session = await getSession()
    if (!session || !(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const result = await prisma.auditLog.deleteMany({
      where: { at: { lt: cutoff } },
    })

    logAudit({
      actorEmail: session.email,
      action: 'audit.purge_run',
      entityType: 'AuditLog',
      changes: { deleted: result.count, cutoff: cutoff.toISOString(), trigger: 'manual' },
    })

    return NextResponse.json({ deleted: result.count, cutoff })
  } catch (error) {
    console.error('POST /api/audit/purge error:', error)
    return NextResponse.json({ error: 'Failed to purge' }, { status: 500 })
  }
}
