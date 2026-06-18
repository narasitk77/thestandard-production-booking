import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { reconcileEquipmentStatus } from '@/lib/equipment-status'
import { RepairStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** PATCH /api/admin/repairs/[id] — update; status is re-derived for the equipment. */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const before = await prisma.repairTicket.findUnique({ where: { id: params.id } })
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if ('itemLabel' in b) data.itemLabel = cleanStr(b.itemLabel) || before.itemLabel
    if ('equipmentId' in b) data.equipmentId = cleanStr(b.equipmentId)
    if ('issue' in b) data.issue = cleanStr(b.issue)
    if ('vendorId' in b) data.vendorId = cleanStr(b.vendorId)
    if ('sentDate' in b) data.sentDate = dateOrNull(b.sentDate)
    if ('returnedDate' in b) data.returnedDate = dateOrNull(b.returnedDate)
    if ('cost' in b) data.cost = decOrNull(b.cost)
    if ('kind' in b) data.kind = cleanStr(b.kind)
    if ('remark' in b) data.remark = cleanStr(b.remark)
    if ('status' in b && inEnum(RepairStatus, b.status)) {
      data.status = b.status
      if (b.status === 'RETURNED' && !('returnedDate' in b)) data.returnedDate = new Date()
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })

    const ticket = await prisma.$transaction(async (tx) => {
      const updated = await tx.repairTicket.update({ where: { id: params.id }, data })
      // Re-derive status for the equipment. Reconcile BOTH the old and the new
      // (re-linked) item so an item unlinked from this ticket is freed and the
      // newly-linked one is taken IN_REPAIR; closing a ticket frees correctly
      // (or returns to ON_LOAN if still out on an active loan).
      if ('status' in data || 'equipmentId' in data) {
        const newEqId = ('equipmentId' in data ? (data.equipmentId as string | null) : before.equipmentId) || null
        await reconcileEquipmentStatus(tx, [before.equipmentId, newEqId])
      }
      return updated
    })
    logAudit({ actorEmail: session.email, action: 'repair.update', entityType: 'RepairTicket', entityId: params.id, fromStatus: before.status, toStatus: (data.status as string) ?? undefined, changes: data })
    return NextResponse.json({ ticket })
  } catch (e: any) {
    console.error('PATCH /api/admin/repairs/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/repairs/[id] — hard delete (documents cascade). */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.repairTicket.findUnique({ where: { id: params.id }, select: { equipmentId: true } })
      await tx.repairTicket.delete({ where: { id: params.id } })
      if (before?.equipmentId) await reconcileEquipmentStatus(tx, [before.equipmentId])
    })
    logAudit({ actorEmail: session.email, action: 'repair.delete', entityType: 'RepairTicket', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/repairs/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
