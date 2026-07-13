import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { PaymentStatus, RentalStatus } from '@prisma/client'
import { resolveOutletId } from '@/lib/rental-helpers'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/rentals/[id] — update (ADMIN: money). Common ops: mark paid
 * (paymentStatus), mark returned (returnedAt + status). Body: any editable subset.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    const b = await request.json()
    const before = await prisma.rentalJob.findUnique({ where: { id: params.id } })
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if ('quoteNo' in b) data.quoteNo = cleanStr(b.quoteNo)
    if ('adType' in b) data.adType = cleanStr(b.adType)
    if ('jobName' in b) data.jobName = cleanStr(b.jobName)
    if ('items' in b) data.items = cleanStr(b.items)
    if ('bookingId' in b) data.bookingId = cleanStr(b.bookingId)
    if ('outletId' in b) data.outletId = await resolveOutletId(b.outletId)
    if ('vendorId' in b) data.vendorId = cleanStr(b.vendorId)
    if ('rentalDate' in b) data.rentalDate = dateOrNull(b.rentalDate)
    if ('returnDueDate' in b) data.returnDueDate = dateOrNull(b.returnDueDate)
    if ('returnedAt' in b) data.returnedAt = dateOrNull(b.returnedAt)
    if ('invoiceNo' in b) data.invoiceNo = cleanStr(b.invoiceNo)
    if ('amount' in b) data.amount = decOrNull(b.amount)
    if ('remark' in b) data.remark = cleanStr(b.remark)
    if ('paymentStatus' in b && inEnum(PaymentStatus, b.paymentStatus)) data.paymentStatus = b.paymentStatus
    if ('status' in b && inEnum(RentalStatus, b.status)) data.status = b.status
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })

    const rental = await prisma.rentalJob.update({ where: { id: params.id }, data })
    logAudit({
      actorEmail: session.email,
      action: 'rental.update',
      entityType: 'RentalJob',
      entityId: params.id,
      fromStatus: 'paymentStatus' in data ? before.paymentStatus : undefined,
      toStatus: 'paymentStatus' in data ? (data.paymentStatus as string) : undefined,
      changes: data,
    })
    return NextResponse.json({ rental })
  } catch (e: any) {
    console.error('PATCH /api/admin/rentals/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/rentals/[id] — hard delete (documents cascade). ADMIN. */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    await prisma.rentalJob.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'rental.delete', entityType: 'RentalJob', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/rentals/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
