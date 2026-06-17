import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, inEnum } from '@/lib/admin-parse'
import { LoanStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

// Free the equipment a loan holds (back to AVAILABLE) — used on return + delete.
async function freeEquipment(tx: any, loanId: string) {
  const items = await tx.equipmentLoanItem.findMany({ where: { loanId, equipmentId: { not: null } }, select: { equipmentId: true } })
  const ids = items.map((i: any) => i.equipmentId).filter(Boolean)
  if (ids.length) await tx.equipment.updateMany({ where: { id: { in: ids } }, data: { status: 'AVAILABLE' } })
}

/**
 * PATCH /api/admin/loans/[id] — most common op is "mark returned"
 * (status=RETURNED → sets returnedAt + frees the gear). Also edits dueDate/etc.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const before = await prisma.equipmentLoan.findUnique({ where: { id: params.id } })
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if ('photographer' in b) data.photographer = cleanStr(b.photographer) || before.photographer
    if ('email' in b) data.email = cleanStr(b.email)
    if ('jobName' in b) data.jobName = cleanStr(b.jobName)
    if ('bookingId' in b) data.bookingId = cleanStr(b.bookingId)
    if ('eventDate' in b) data.eventDate = dateOrNull(b.eventDate)
    if ('dueDate' in b) data.dueDate = dateOrNull(b.dueDate)
    const returning = inEnum(LoanStatus, b.status) && b.status === 'RETURNED' && before.status !== 'RETURNED'
    if ('status' in b && inEnum(LoanStatus, b.status)) {
      data.status = b.status
      if (b.status === 'RETURNED') data.returnedAt = dateOrNull(b.returnedAt) || new Date()
      if (b.status === 'ACTIVE') data.returnedAt = null
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })

    const loan = await prisma.$transaction(async (tx) => {
      const updated = await tx.equipmentLoan.update({ where: { id: params.id }, data, include: { items: true } })
      if (returning) await freeEquipment(tx, params.id)
      return updated
    })
    logAudit({ actorEmail: session.email, action: 'loan.update', entityType: 'EquipmentLoan', entityId: params.id, fromStatus: before.status, toStatus: (data.status as string) ?? undefined, changes: data })
    return NextResponse.json({ loan })
  } catch (e: any) {
    console.error('PATCH /api/admin/loans/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/loans/[id] — remove loan (items cascade) + free its gear. */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    await prisma.$transaction(async (tx) => {
      await freeEquipment(tx, params.id)
      await tx.equipmentLoan.delete({ where: { id: params.id } })
    })
    logAudit({ actorEmail: session.email, action: 'loan.delete', entityType: 'EquipmentLoan', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/loans/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
