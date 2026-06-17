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
 * For an existing user we merge the outlet into producerOutlets (never drop
 * outlets they already had) and fill nickname/thaiName/employeeId/position;
 * role and active are left untouched so we never demote or disable anyone.
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
      select: { id: true, producerOutlets: true },
    })
    if (existing) {
      const outlets = Array.from(new Set([...(existing.producerOutlets || []), ...outletTag]))
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          thaiName: p.thaiName,
          nickname: p.nickname,
          employeeId: p.employeeId,
          position: p.position,
          producerOutlets: outlets,
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
