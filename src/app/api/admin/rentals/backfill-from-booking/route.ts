import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { bookingDisplayName } from '@/lib/display'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/rentals/backfill-from-booking?apply=1
 *
 * v1.145 one-time cleanup for rentals entered before the form restructure, when
 * "ชื่องาน" was (mis)used for WHAT was rented. For every live (non-ARCHIVED)
 * rental linked to a booking:
 *   - items    ← old jobName (only when items is still empty — the move)
 *   - jobName  ← the booking's display name (what ชื่องาน means now)
 *   - adType   ← AD/NON-AD from booking.category   (only when empty)
 *   - quoteNo  ← booking.agencyRef                 (only when empty)
 *   - rentalDate/returnDueDate ← shootDate/shootEndDate (only when empty)
 *   - outletId ← booking.outletId                  (only when empty)
 * Unlinked + ARCHIVED rentals are untouched. Idempotent: a second run finds
 * items already set and jobName already correct → no writes. Dry-run default.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const apply = new URL(request.url).searchParams.get('apply') === '1'
  const rentals = await prisma.rentalJob.findMany({
    where: { status: { not: 'ARCHIVED' }, bookingId: { not: null } },
    include: {
      booking: {
        include: {
          program: { select: { code: true, name: true } },
          episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { code: true, name: true } } } },
        },
      },
    },
  })

  const results: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> } | { id: string; skipped: string }> = []
  let changed = 0
  for (const r of rentals) {
    const b = r.booking
    if (!b) { results.push({ id: r.id, skipped: 'booking missing' }); continue }
    const name = bookingDisplayName(b)
    const epTitle = b.episodes?.[0]?.title?.trim()
    const jobLabel = epTitle && !name.includes(epTitle) ? `${name} — ${epTitle}` : name

    const data: Record<string, unknown> = {}
    // the MOVE: old jobName was the rented items — keep it, in the right field
    if (!r.items?.trim() && r.jobName?.trim() && r.jobName.trim() !== jobLabel) data.items = r.jobName.trim()
    if (r.jobName?.trim() !== jobLabel) data.jobName = jobLabel
    if (!r.adType?.trim() && b.category) data.adType = b.category === 'ADVERTORIAL' ? 'AD' : 'NON-AD'
    if (!r.quoteNo?.trim() && b.agencyRef?.trim()) data.quoteNo = b.agencyRef.trim()
    if (!r.rentalDate && b.shootDate) data.rentalDate = b.shootDate
    if (!r.returnDueDate && (b.shootEndDate || b.shootDate)) data.returnDueDate = b.shootEndDate || b.shootDate
    if (!r.outletId && b.outletId) data.outletId = b.outletId

    if (Object.keys(data).length === 0) { results.push({ id: r.id, skipped: 'already correct' }); continue }
    changed++
    results.push({
      id: r.id,
      before: { jobName: r.jobName, items: r.items, adType: r.adType, quoteNo: r.quoteNo, rentalDate: r.rentalDate, returnDueDate: r.returnDueDate, outletId: r.outletId },
      after: data,
    })
    if (apply) await prisma.rentalJob.update({ where: { id: r.id }, data })
  }

  if (apply && changed > 0) {
    logAudit({
      actorEmail: session.email, action: 'rental.backfill_from_booking',
      entityType: 'RentalJob', changes: { total: rentals.length, changed },
    })
  }
  return NextResponse.json({ ok: true, dryRun: !apply, total: rentals.length, changed, results })
}
