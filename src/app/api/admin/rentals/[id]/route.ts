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

/**
 * DELETE /api/admin/rentals/[id] — hard delete. ADMIN.
 *
 * DocumentRef rows cascade (schema `onDelete: Cascade`), but the FILES in Drive
 * are untouched: the money paperwork outlives the tracker row on purpose, and
 * `driveFolderId` is returned below so the folder can still be found afterwards.
 *
 * v1.180 — the audit row used to carry the id and nothing else, which after a
 * hard delete resolves to nothing: you could see that someone deleted *a* rental
 * and never learn which. Snapshot the identifying fields into `changes` first.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    const before = await prisma.rentalJob.findUnique({
      where: { id: params.id },
      select: {
        jobName: true, quoteNo: true, items: true, invoiceNo: true, amount: true,
        paymentStatus: true, status: true, rentalDate: true, returnDueDate: true,
        driveFolderId: true,
        vendor: { select: { name: true } },
        booking: { select: { bookingCode: true } },
        _count: { select: { documents: true } },
      },
    })
    if (!before) return NextResponse.json({ error: 'ไม่พบงานเช่านี้ (อาจถูกลบไปแล้ว)' }, { status: 404 })

    await prisma.rentalJob.delete({ where: { id: params.id } })
    logAudit({
      actorEmail: session.email,
      action: 'rental.delete',
      entityType: 'RentalJob',
      entityId: params.id,
      fromStatus: before.status,
      changes: {
        jobName: before.jobName,
        quoteNo: before.quoteNo,
        items: before.items,
        invoiceNo: before.invoiceNo,
        amount: before.amount ? String(before.amount) : null,
        paymentStatus: before.paymentStatus,
        rentalDate: before.rentalDate,
        returnDueDate: before.returnDueDate,
        vendor: before.vendor?.name ?? null,
        bookingCode: before.booking?.bookingCode ?? null,
        // How much paperwork lost its DB reference, and where the files still live.
        documentsDetached: before._count.documents,
        driveFolderId: before.driveFolderId,
      },
    })
    return NextResponse.json({
      success: true,
      documentsDetached: before._count.documents,
      driveFolderId: before.driveFolderId,
    })
  } catch (e: any) {
    console.error('DELETE /api/admin/rentals/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
