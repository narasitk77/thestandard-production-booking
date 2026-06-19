import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const data: Record<string, unknown> = {}
    if ('vendor' in b) data.vendor = cleanStr(b.vendor) || ''
    if ('category' in b) data.category = cleanStr(b.category) || ''
    if ('item' in b) data.item = cleanStr(b.item) || ''
    if ('spec' in b) data.spec = cleanStr(b.spec)
    if ('unit' in b) data.unit = cleanStr(b.unit) || 'วัน'
    if ('pricePerDay' in b) data.pricePerDay = parseFloat(b.pricePerDay) || 0
    if ('notes' in b) data.notes = cleanStr(b.notes)
    if (!Object.keys(data).length) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })
    const price = await prisma.vendorPrice.update({ where: { id: params.id }, data })
    logAudit({ actorEmail: session.email, action: 'vendorPrice.update', entityType: 'VendorPrice', entityId: params.id, changes: data })
    return NextResponse.json({ price })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    await prisma.vendorPrice.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'vendorPrice.delete', entityType: 'VendorPrice', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
