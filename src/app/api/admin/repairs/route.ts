import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { reconcileEquipmentStatus } from '@/lib/equipment-status'
import { RepairStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** GET /api/admin/repairs — list. Query: ?status=REPORTED|SENT|RETURNED|CANNOT_REPAIR|all */
export async function GET(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const status = (new URL(request.url).searchParams.get('status') || '').toUpperCase()
  const where: any = {}
  if (inEnum(RepairStatus, status)) where.status = status
  const repairs = await prisma.repairTicket.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { vendor: { select: { id: true, name: true } }, equipment: { select: { id: true, name: true } }, documents: true },
  })
  return NextResponse.json({ repairs })
}

/**
 * POST /api/admin/repairs — open a repair ticket.
 * Body: { itemLabel, equipmentId?, issue?, vendorId?, status?, sentDate?, cost?, kind?, remark? }
 * If linked to equipment and the status is open, the item flips to IN_REPAIR.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const itemLabel = cleanStr(b.itemLabel) || cleanStr(b.item)
    if (!itemLabel) return NextResponse.json({ error: 'itemLabel is required' }, { status: 400 })
    const status = inEnum(RepairStatus, b.status) ? b.status : 'REPORTED'
    const equipmentId = cleanStr(b.equipmentId)
    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.repairTicket.create({
        data: {
          itemLabel,
          equipmentId,
          issue: cleanStr(b.issue),
          vendorId: cleanStr(b.vendorId),
          status,
          sentDate: dateOrNull(b.sentDate),
          returnedDate: dateOrNull(b.returnedDate),
          cost: decOrNull(b.cost),
          kind: cleanStr(b.kind),
          remark: cleanStr(b.remark),
        },
      })
      // Derive status (IN_REPAIR while the ticket is open) from the live world.
      if (equipmentId) await reconcileEquipmentStatus(tx, [equipmentId])
      return created
    })
    logAudit({ actorEmail: session.email, action: 'repair.create', entityType: 'RepairTicket', entityId: ticket.id, changes: { itemLabel } })
    return NextResponse.json({ ticket }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/repairs error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
