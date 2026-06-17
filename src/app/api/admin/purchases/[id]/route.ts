import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, decOrNull, intOr, inEnum } from '@/lib/admin-parse'
import { PurchaseStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** PATCH /api/admin/purchases/[id] — update (ADMIN: money). */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    const b = await request.json()
    const data: Record<string, unknown> = {}
    if ('month' in b) data.month = cleanStr(b.month)
    if ('item' in b) {
      const item = cleanStr(b.item)
      if (!item) return NextResponse.json({ error: 'item cannot be empty' }, { status: 400 })
      data.item = item
    }
    if ('quantity' in b) data.quantity = intOr(b.quantity, 1)
    if ('vendorId' in b) data.vendorId = cleanStr(b.vendorId)
    if ('productLink' in b) data.productLink = cleanStr(b.productLink)
    if ('unitPrice' in b) data.unitPrice = decOrNull(b.unitPrice)
    if ('total' in b) data.total = decOrNull(b.total)
    if ('kind' in b) data.kind = cleanStr(b.kind)
    if ('remark' in b) data.remark = cleanStr(b.remark)
    if ('status' in b && inEnum(PurchaseStatus, b.status)) data.status = b.status
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })
    const purchase = await prisma.purchaseItem.update({ where: { id: params.id }, data })
    logAudit({ actorEmail: session.email, action: 'purchase.update', entityType: 'PurchaseItem', entityId: params.id, changes: data })
    return NextResponse.json({ purchase })
  } catch (e: any) {
    console.error('PATCH /api/admin/purchases/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/purchases/[id] — hard delete (documents cascade). ADMIN. */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    await prisma.purchaseItem.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'purchase.delete', entityType: 'PurchaseItem', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/purchases/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
