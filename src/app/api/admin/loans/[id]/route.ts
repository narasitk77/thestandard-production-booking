import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, inEnum } from '@/lib/admin-parse'
import { reconcileEquipmentStatus } from '@/lib/equipment-status'
import { LoanStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

// Equipment ids a loan currently references — reconciled (not blindly freed)
// after the loan's state changes, so an item still held by another active loan
// or sitting IN_REPAIR is not wrongly flipped to AVAILABLE.
async function loanEquipmentIds(tx: any, loanId: string): Promise<string[]> {
  const items = await tx.equipmentLoanItem.findMany({ where: { loanId, equipmentId: { not: null } }, select: { equipmentId: true } })
  return items.map((i: any) => i.equipmentId).filter(Boolean)
}

/**
 * PATCH /api/admin/loans/[id] — most common op is "mark returned"
 * (status=RETURNED → sets returnedAt + frees the gear). Also edits dueDate/etc.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
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
    if ('status' in b && inEnum(LoanStatus, b.status)) {
      data.status = b.status
      if (b.status === 'RETURNED') data.returnedAt = dateOrNull(b.returnedAt) || new Date()
      if (b.status === 'ACTIVE') data.returnedAt = null
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })

    const loan = await prisma.$transaction(async (tx) => {
      const updated = await tx.equipmentLoan.update({ where: { id: params.id }, data, include: { items: true } })
      // Loan active-ness may have flipped (return or un-return) — re-derive the
      // linked gear's status instead of blindly freeing it.
      if ('status' in data) await reconcileEquipmentStatus(tx, await loanEquipmentIds(tx, params.id))
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
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    await prisma.$transaction(async (tx) => {
      const ids = await loanEquipmentIds(tx, params.id)
      await tx.equipmentLoan.delete({ where: { id: params.id } })
      await reconcileEquipmentStatus(tx, ids)
    })
    logAudit({ actorEmail: session.email, action: 'loan.delete', entityType: 'EquipmentLoan', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/loans/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
