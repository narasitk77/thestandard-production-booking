import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, decOrNull, intOr, inEnum } from '@/lib/admin-parse'
import { PurchaseStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** GET /api/admin/purchases — list. Query: ?status=, ?month=YYYY-MM */
export async function GET(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const status = (sp.get('status') || '').toUpperCase()
  const month = cleanStr(sp.get('month'))
  const where: any = {}
  if (inEnum(PurchaseStatus, status)) where.status = status
  if (month) where.month = month
  const purchases = await prisma.purchaseItem.findMany({
    where,
    orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
    include: { vendor: { select: { id: true, name: true } }, documents: true },
  })
  return NextResponse.json({ purchases })
}

/** POST /api/admin/purchases — create (ADMIN: money). */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    const b = await request.json()
    const item = cleanStr(b.item)
    if (!item) return NextResponse.json({ error: 'item is required' }, { status: 400 })
    const status = inEnum(PurchaseStatus, b.status) ? b.status : 'OPEN'
    const purchase = await prisma.purchaseItem.create({
      data: {
        month: cleanStr(b.month),
        item,
        quantity: intOr(b.quantity, 1),
        vendorId: cleanStr(b.vendorId),
        productLink: cleanStr(b.productLink),
        unitPrice: decOrNull(b.unitPrice),
        total: decOrNull(b.total),
        kind: cleanStr(b.kind),
        status,
        remark: cleanStr(b.remark),
      },
    })
    logAudit({ actorEmail: session.email, action: 'purchase.create', entityType: 'PurchaseItem', entityId: purchase.id, changes: { item } })
    return NextResponse.json({ purchase }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/purchases error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
