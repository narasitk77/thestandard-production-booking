import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { EquipmentCategory, EquipmentStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** GET /api/admin/equipment/[id] — one item + its loan & repair history. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const equipment = await prisma.equipment.findUnique({
    where: { id: params.id },
    include: {
      loans: { include: { loan: { select: { loanCode: true, photographer: true, status: true, dueDate: true, returnedAt: true } } } },
      repairs: { orderBy: { createdAt: 'desc' }, include: { vendor: { select: { name: true } } } },
    },
  })
  if (!equipment) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ equipment })
}

/** PATCH /api/admin/equipment/[id] — update. */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const data: Record<string, unknown> = {}
    if ('itemId' in b) data.itemId = cleanStr(b.itemId)
    if ('name' in b) {
      const name = cleanStr(b.name)
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if ('description' in b) data.description = cleanStr(b.description)
    if ('serialNumber' in b) data.serialNumber = cleanStr(b.serialNumber)
    if ('category' in b && inEnum(EquipmentCategory, b.category)) data.category = b.category
    if ('location' in b) data.location = cleanStr(b.location)
    if ('status' in b && inEnum(EquipmentStatus, b.status)) data.status = b.status
    if ('loanable' in b) data.loanable = b.loanable === true
    if ('notes' in b) data.notes = cleanStr(b.notes)
    if ('isFixedAsset' in b) data.isFixedAsset = b.isFixedAsset === true
    if ('fixedAssetTag' in b) data.fixedAssetTag = cleanStr(b.fixedAssetTag)
    if ('purchaseDate' in b) data.purchaseDate = dateOrNull(b.purchaseDate)
    if ('purchasePrice' in b) data.purchasePrice = decOrNull(b.purchasePrice)
    if ('warrantyExpiresAt' in b) data.warrantyExpiresAt = dateOrNull(b.warrantyExpiresAt)
    if ('depreciationNote' in b) data.depreciationNote = cleanStr(b.depreciationNote)
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })
    const equipment = await prisma.equipment.update({ where: { id: params.id }, data })
    logAudit({ actorEmail: session.email, action: 'equipment.update', entityType: 'Equipment', entityId: params.id, changes: data })
    return NextResponse.json({ equipment })
  } catch (e: any) {
    console.error('PATCH /api/admin/equipment/[id] error:', e)
    if (e?.code === 'P2002') return NextResponse.json({ error: 'itemId already exists' }, { status: 409 })
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/equipment/[id] — only when it has no loan/repair history. */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const counts = await prisma.equipment.findUnique({
      where: { id: params.id },
      select: { _count: { select: { loans: true, repairs: true } } },
    })
    if (!counts) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (counts._count.loans > 0 || counts._count.repairs > 0) {
      return NextResponse.json({ error: 'มีประวัติยืม/ซ่อม — ตั้งสถานะเป็น RETIRED แทนการลบ' }, { status: 409 })
    }
    await prisma.equipment.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'equipment.delete', entityType: 'Equipment', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/equipment/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
