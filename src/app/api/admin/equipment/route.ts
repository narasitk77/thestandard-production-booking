import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { EquipmentCategory, EquipmentStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/equipment — list inventory.
 * Query: ?category=, ?status=, ?loanable=1, ?q=<search>, ?fixedAsset=1|0
 */
export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const category = (sp.get('category') || '').toUpperCase()
  const status = (sp.get('status') || '').toUpperCase()
  const q = cleanStr(sp.get('q'))
  const where: any = {}
  if (inEnum(EquipmentCategory, category)) where.category = category
  if (inEnum(EquipmentStatus, status)) where.status = status
  if (sp.get('loanable') === '1') where.loanable = true
  if (sp.get('fixedAsset') === '1') where.isFixedAsset = true
  if (sp.get('fixedAsset') === '0') where.isFixedAsset = false
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { serialNumber: { contains: q, mode: 'insensitive' } },
      { itemId: { contains: q, mode: 'insensitive' } },
      { fixedAssetTag: { contains: q, mode: 'insensitive' } },
    ]
  }
  const equipment = await prisma.equipment.findMany({
    where,
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  return NextResponse.json({ equipment })
}

/** POST /api/admin/equipment — create one item. */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const name = cleanStr(b.name)
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const category = inEnum(EquipmentCategory, b.category) ? b.category : 'UNCATEGORIZED'
    const status = inEnum(EquipmentStatus, b.status) ? b.status : 'AVAILABLE'
    const equipment = await prisma.equipment.create({
      data: {
        itemId: cleanStr(b.itemId),
        name,
        description: cleanStr(b.description),
        serialNumber: cleanStr(b.serialNumber),
        category,
        location: cleanStr(b.location),
        status,
        loanable: b.loanable !== false,
        notes: cleanStr(b.notes),
        isFixedAsset: b.isFixedAsset === true,
        fixedAssetTag: cleanStr(b.fixedAssetTag),
        purchaseDate: dateOrNull(b.purchaseDate),
        purchasePrice: decOrNull(b.purchasePrice),
        warrantyExpiresAt: dateOrNull(b.warrantyExpiresAt),
        depreciationNote: cleanStr(b.depreciationNote),
      },
    })
    logAudit({ actorEmail: session.email, action: 'equipment.create', entityType: 'Equipment', entityId: equipment.id, changes: { name } })
    return NextResponse.json({ equipment }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/equipment error:', e)
    if (e?.code === 'P2002') return NextResponse.json({ error: 'itemId already exists' }, { status: 409 })
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
