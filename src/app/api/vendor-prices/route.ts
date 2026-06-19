import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET /api/vendor-prices — public price lookup for cost-sheet tool.
 *  ?q=lens   full-text search across item/spec/category
 *  ?vendor=  filter by vendor name
 *  ?category= filter by category
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() || ''
  const vendor = searchParams.get('vendor')?.trim() || ''
  const category = searchParams.get('category')?.trim() || ''

  const where: Record<string, unknown> = {}
  if (vendor) where.vendor = { equals: vendor, mode: 'insensitive' }
  if (category) where.category = { equals: category, mode: 'insensitive' }
  if (q) {
    where.OR = [
      { item: { contains: q, mode: 'insensitive' } },
      { spec: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { vendor: { contains: q, mode: 'insensitive' } },
    ]
  }

  const prices = await prisma.vendorPrice.findMany({
    where,
    orderBy: [{ category: 'asc' }, { item: 'asc' }, { vendor: 'asc' }],
    take: 200,
    select: { id: true, vendor: true, category: true, item: true, spec: true, unit: true, pricePerDay: true, notes: true },
  })

  const response = NextResponse.json({ prices })
  response.headers.set('Access-Control-Allow-Origin', '*')
  return response
}
