import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { OUTLET_PRODUCERS } from '@/lib/outlet-producers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/import-producers — v1.59.0. ADMIN only.
 *
 * Upserts the outlet Producer / Co-Producer roster (src/lib/outlet-producers.ts,
 * sourced from the ops "outlet DB" sheet) into the User table so they (a) have
 * an account to sign into and (b) appear in the per-outlet Producer dropdowns
 * (GET /api/producers). Idempotent: re-run anytime after editing the seed.
 *
 * v1.108 — the seed is AUTHORITATIVE for outlet membership: an existing user's
 * producerOutlets is SET to exactly the seed outlet (not merged), so moving a
 * person between outlets in the seed actually removes the old tag on re-run
 * (a merge-only import left stale tags — e.g. ปลั๊กไฟ stuck in KND). nickname/
 * thaiName/employeeId/position are filled; role and active are left untouched
 * so we never demote or disable anyone.
 */
export async function POST() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  let created = 0
  let updated = 0
  for (const p of OUTLET_PRODUCERS) {
    const email = p.email.toLowerCase()
    // role 'Other' (e.g. Switcher) gets an account but is NOT tagged as an
    // outlet producer, so they never appear in the Producer/Co-Producer dropdown.
    const outletTag = p.role === 'Other' ? [] : [p.outlet]
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          thaiName: p.thaiName,
          nickname: p.nickname,
          employeeId: p.employeeId,
          position: p.position,
          producerOutlets: outletTag, // authoritative — seed defines the outlet(s); stale tags removed
        },
      })
      updated++
    } else {
      await prisma.user.create({
        data: {
          email,
          thaiName: p.thaiName,
          nickname: p.nickname,
          employeeId: p.employeeId,
          position: p.position,
          role: 'USER',
          active: true,
          producerOutlets: outletTag,
        },
      })
      created++
    }
  }

  logAudit({
    actorEmail: session.email,
    action: 'admin.import_producers',
    entityType: 'User',
    entityId: 'outlet-producers',
    changes: { total: OUTLET_PRODUCERS.length, created, updated },
  })

  return NextResponse.json({ ok: true, total: OUTLET_PRODUCERS.length, created, updated })
}
