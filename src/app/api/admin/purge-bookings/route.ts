import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/purge-bookings
 * Returns counts of records that would be deleted. ADMIN only.
 */
export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [bookings, episodes, auditLogs, uploads, footageLogs] = await Promise.all([
    prisma.booking.count(),
    prisma.episode.count(),
    prisma.auditLog.count(),
    prisma.upload.count(),
    prisma.footageLog.count(),
  ])

  return NextResponse.json({ bookings, episodes, auditLogs, uploads, footageLogs })
}

/**
 * POST /api/admin/purge-bookings
 * Body: { confirm: true }
 * Deletes ALL bookings + related records. ADMIN only. Irreversible.
 *
 * Delete order:
 *   1. audit_logs       — no FK, safe to delete first
 *   2. footage_log      — bookingId is nullable, no cascade
 *   3. bookings         — cascades: episodes, uploads (onDelete: Cascade in schema)
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  if (body?.confirm !== true) {
    return NextResponse.json({ error: 'Missing confirm:true in body' }, { status: 400 })
  }

  // Snapshot counts before delete (for audit log + response)
  const [bookingCount, episodeCount, auditCount, uploadCount, footageCount] = await Promise.all([
    prisma.booking.count(),
    prisma.episode.count(),
    prisma.auditLog.count(),
    prisma.upload.count(),
    prisma.footageLog.count(),
  ])

  // Execute in a transaction for atomicity
  await prisma.$transaction([
    prisma.auditLog.deleteMany({}),
    prisma.footageLog.deleteMany({}),
    prisma.booking.deleteMany({}), // cascades episodes + uploads
  ])

  // Write a single audit trail entry about the purge itself
  await logAudit({
    actorEmail: session.email,
    action: 'admin.purge_all_bookings',
    entityType: 'system',
    entityId: 'all',
    changes: { bookingCount, episodeCount, auditCount, uploadCount, footageCount },
  })

  return NextResponse.json({
    ok: true,
    deleted: { bookingCount, episodeCount, auditCount, uploadCount, footageCount },
  })
}
