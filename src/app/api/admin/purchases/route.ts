import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, decOrNull, dateOrNull, intOr } from '@/lib/admin-parse'
import { MONTH_RE, isBatchEditable, batchTotal } from '@/lib/purchase-batch'

export const dynamic = 'force-dynamic'

const itemInclude = { vendor: { select: { id: true, name: true } }, documents: true } as const

function withTotals<T extends { items: { quantity: number; unitPrice: unknown; total: unknown }[] }>(b: T) {
  const items = b.items.map(i => ({
    ...i,
    unitPrice: i.unitPrice == null ? null : Number(i.unitPrice),
    total: i.total == null ? null : Number(i.total),
  }))
  return { ...b, items, grandTotal: batchTotal(items), itemCount: items.length }
}

/**
 * GET /api/admin/purchases
 *   ?batchId=…      → one batch + its items (a manager opens any buyer's month)
 *   ?month=YYYY-MM  → the CURRENT user's batch for that month (null if none yet)
 *   (no params)     → overview: every batch with its total + item count
 */
export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const batchId = cleanStr(sp.get('batchId'))
  const month = cleanStr(sp.get('month'))

  if (batchId) {
    const batch = await prisma.purchaseBatch.findUnique({
      where: { id: batchId },
      include: { items: { orderBy: { createdAt: 'asc' }, include: itemInclude } },
    })
    if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ batch: withTotals(batch) })
  }

  if (month) {
    if (!MONTH_RE.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    const batch = await prisma.purchaseBatch.findUnique({
      where: { ownerEmail_month: { ownerEmail: session.email, month } },
      include: { items: { orderBy: { createdAt: 'asc' }, include: itemInclude } },
    })
    return NextResponse.json({ batch: batch ? withTotals(batch) : null, month })
  }

  const batches = await prisma.purchaseBatch.findMany({
    orderBy: [{ month: 'desc' }, { ownerEmail: 'asc' }],
    include: { items: { select: { quantity: true, unitPrice: true, total: true } } },
  })
  return NextResponse.json({ batches: batches.map(withTotals) })
}

/**
 * POST /api/admin/purchases — add an item to the CURRENT user's batch for a
 * month. Creates the (DRAFT) batch on first item. Blocked once submitted/approved.
 * Body: { month, item, purchaseDate?, quantity?, vendorId?, productLink?, unitPrice?, total?, kind?, remark? }
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const month = cleanStr(b.month)
    const item = cleanStr(b.item)
    if (!month || !MONTH_RE.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    if (!item) return NextResponse.json({ error: 'item is required' }, { status: 400 })

    const batch = await prisma.purchaseBatch.upsert({
      where: { ownerEmail_month: { ownerEmail: session.email, month } },
      create: { ownerEmail: session.email, month },
      update: {},
    })
    if (!isBatchEditable(batch.status)) {
      return NextResponse.json({ error: 'เดือนนี้ส่งอนุมัติแล้ว — แก้ไขไม่ได้' }, { status: 400 })
    }

    const purchase = await prisma.purchase.create({
      data: {
        batchId: batch.id,
        item,
        purchaseDate: dateOrNull(b.purchaseDate),
        quantity: intOr(b.quantity, 1),
        vendorId: cleanStr(b.vendorId),
        productLink: cleanStr(b.productLink),
        unitPrice: decOrNull(b.unitPrice),
        total: decOrNull(b.total),
        kind: cleanStr(b.kind),
        remark: cleanStr(b.remark),
      },
      include: itemInclude,
    })
    logAudit({ actorEmail: session.email, action: 'purchase.item.create', entityType: 'Purchase', entityId: purchase.id, changes: { month, item } })
    return NextResponse.json({ purchase }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/purchases error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
