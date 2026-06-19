import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() || ''
  const where = q ? {
    OR: [
      { item: { contains: q, mode: 'insensitive' as const } },
      { vendor: { contains: q, mode: 'insensitive' as const } },
      { category: { contains: q, mode: 'insensitive' as const } },
      { spec: { contains: q, mode: 'insensitive' as const } },
    ],
  } : {}
  const prices = await prisma.vendorPrice.findMany({
    where,
    orderBy: [{ vendor: 'asc' }, { category: 'asc' }, { item: 'asc' }],
  })
  return NextResponse.json({ prices })
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const vendor = cleanStr(b.vendor)
    const category = cleanStr(b.category)
    const item = cleanStr(b.item)
    if (!vendor || !category || !item) return NextResponse.json({ error: 'vendor, category, item required' }, { status: 400 })
    const price = await prisma.vendorPrice.create({
      data: {
        vendor, category, item,
        spec: cleanStr(b.spec),
        unit: cleanStr(b.unit) || 'วัน',
        pricePerDay: parseFloat(b.pricePerDay) || 0,
        notes: cleanStr(b.notes),
      },
    })
    logAudit({ actorEmail: session.email, action: 'vendorPrice.create', entityType: 'VendorPrice', entityId: price.id, changes: { vendor, category, item } })
    return NextResponse.json({ price }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
