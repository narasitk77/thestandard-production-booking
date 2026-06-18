import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'

export const dynamic = 'force-dynamic'

/** PATCH /api/admin/vendors/[id] — body: subset of { name, service, contact, bankAccount } */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const data: Record<string, unknown> = {}
    if ('name' in b) {
      const name = cleanStr(b.name)
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if ('service' in b) data.service = cleanStr(b.service)
    if ('contact' in b) data.contact = cleanStr(b.contact)
    if ('bankAccount' in b) data.bankAccount = cleanStr(b.bankAccount)
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No editable fields' }, { status: 400 })
    const vendor = await prisma.vendor.update({ where: { id: params.id }, data })
    logAudit({ actorEmail: session.email, action: 'vendor.update', entityType: 'Vendor', entityId: params.id, changes: data })
    return NextResponse.json({ vendor })
  } catch (e: any) {
    console.error('PATCH /api/admin/vendors/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/admin/vendors/[id] — vendorId on rentals/repairs/purchases becomes null. */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    await prisma.vendor.delete({ where: { id: params.id } })
    logAudit({ actorEmail: session.email, action: 'vendor.delete', entityType: 'Vendor', entityId: params.id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('DELETE /api/admin/vendors/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
