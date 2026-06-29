import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, decOrNull, dateOrNull, intOr } from '@/lib/admin-parse'
import { isBatchEditable } from '@/lib/purchase-batch'

export const dynamic = 'force-dynamic'

const itemInclude = { vendor: { select: { id: true, name: true } }, documents: true } as const

/** The caller must OWN the item's batch and it must be DRAFT/REJECTED to mutate. Error response or null. */
async function guardEditable(id: string, email: string) {
  const existing = await prisma.purchase.findUnique({ where: { id }, select: { batch: { select: { status: true, ownerEmail: true } } } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.batch.ownerEmail !== email) return NextResponse.json({ error: 'แก้ไขได้เฉพาะรายการของตนเอง' }, { status: 403 })
  if (!isBatchEditable(existing.batch.status)) return NextResponse.json({ error: 'เดือนนี้ส่งอนุมัติแล้ว — แก้ไขไม่ได้' }, { status: 400 })
  return null
}

/** PATCH /api/admin/purchases/[id] — edit one item (only while its month is editable). */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const blocked = await guardEditable(params.id, session.email)
    if (blocked) return blocked
    const b = await request.json()
    const data: Record<string, unknown> = {}
    if ('item' in b) {
      const item = cleanStr(b.item)
      if (!item) return NextResponse.json({ error: 'item cannot be empty' }, { status: 400 })
      data.item = item
    }
    if ('purchaseDate' in b) data.purchaseDate = dateOrNull(b.purchaseDate)
    if ('quantity' in b) data.quantity = Math.max(1, intOr(b.quantity, 1))
    if ('vendorId' in b) data.vendorId = cleanStr(b.vendorId)
    if ('productLink' in b) data.productLink = cleanStr(b.productLink)
    if ('unitPrice' in b) data.unitPrice = decOrNull(b.unitPrice)
    if ('total' in b) data.total = decOrNull(b.total)
    if ('kind' in b) data.kind = cleanStr(b.kind)
    if ('remark' in b) data.remark = cleanStr(b.remark)
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })
    const purchase = await prisma.purchase.update({ where: { id: params.id }, data, include: itemInclude })
    logAudit({ actorEmail: session.email, action: 'purchase.item.update', entityType: 'Purchase', entityId: params.id, changes: data })
    return NextResponse.json({ purchase })
  } catch (e: any) {
    console.error('PATCH /api/admin/purchases/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/purchases/[id] — remove one item (documents cascade). */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const blocked = await guardEditable(params.id, session.email)
    if (blocked) return blocked
    await prisma.purchase.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'purchase.item.delete', entityType: 'Purchase', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/purchases/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
