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
 * Body: { confirm: 'DELETE ALL' }
 * Deletes ALL bookings + related records. ADMIN only. Irreversible.
 *
 * Delete order (mirrors the single-booking delete route):
 *   1. audit_logs (Booking-related only) — no FK, safe to delete first
 *   2. footage_log      — bookingId is nullable, no cascade
 *   3. ot_records       — auto-generated rows referencing a booking, no cascade
 *   4. bookings         — cascades: episodes, uploads (onDelete: Cascade in schema)
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  // Require the literal phrase the UI forces the admin to type, not just a
  // boolean — a boolean is trivial to replay from a stray script/old request.
  if (body?.confirm !== 'DELETE ALL') {
    return NextResponse.json({ error: "Missing confirm:'DELETE ALL' in body" }, { status: 400 })
  }

  // Snapshot counts before delete (for audit log + response)
  const [bookingCount, episodeCount, auditCount, uploadCount, footageCount] = await Promise.all([
    prisma.booking.count(),
    prisma.episode.count(),
    prisma.auditLog.count({ where: { entityType: { in: ['Booking', 'booking'] } } }),
    prisma.upload.count(),
    prisma.footageLog.count(),
  ])

  // Execute in a transaction for atomicity. Only Booking-scoped audit logs
  // are deleted — this used to wipe the ENTIRE audit_logs table, including
  // unrelated Program/Equipment/Vendor/Purchase/User trail entries.
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { entityType: { in: ['Booking', 'booking'] } } }),
    prisma.footageLog.deleteMany({}),
    prisma.oTRecord.deleteMany({ where: { bookingId: { not: null } } }),
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
