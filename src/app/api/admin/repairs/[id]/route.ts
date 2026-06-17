import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { RepairStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

const CLOSED: RepairStatus[] = ['RETURNED', 'CANNOT_REPAIR']

/** PATCH /api/admin/repairs/[id] — update; closing it frees the linked equipment. */
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
    let closing = false
    if ('status' in b && inEnum(RepairStatus, b.status)) {
      data.status = b.status
      closing = CLOSED.includes(b.status) && !CLOSED.includes(before.status)
      if (b.status === 'RETURNED' && !('returnedDate' in b)) data.returnedDate = new Date()
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })

    const ticket = await prisma.$transaction(async (tx) => {
      const updated = await tx.repairTicket.update({ where: { id: params.id }, data })
      // Free the equipment when the ticket closes (if it's not out on loan).
      const eqId = (data.equipmentId as string | null | undefined) ?? before.equipmentId
      if (closing && eqId) {
        const eq = await tx.equipment.findUnique({ where: { id: eqId }, select: { status: true } })
        if (eq && eq.status === 'IN_REPAIR') await tx.equipment.update({ where: { id: eqId }, data: { status: 'AVAILABLE' } })
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
    await prisma.repairTicket.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'repair.delete', entityType: 'RepairTicket', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/repairs/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
