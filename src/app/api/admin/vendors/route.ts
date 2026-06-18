import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'

export const dynamic = 'force-dynamic'

/** GET /api/admin/vendors — list vendors (with rental/repair/purchase counts). */
export async function GET() {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const vendors = await prisma.vendor.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { rentals: true, repairs: true, purchases: true } } },
  })
  return NextResponse.json({ vendors })
}

/** POST /api/admin/vendors — create. Body: { name, service?, contact?, bankAccount? } */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const name = cleanStr(b.name)
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const existing = await prisma.vendor.findUnique({ where: { name } })
    if (existing) return NextResponse.json({ error: `Vendor "${name}" already exists` }, { status: 409 })
    const vendor = await prisma.vendor.create({
      data: { name, service: cleanStr(b.service), contact: cleanStr(b.contact), bankAccount: cleanStr(b.bankAccount) },
    })
    logAudit({ actorEmail: session.email, action: 'vendor.create', entityType: 'Vendor', entityId: vendor.id, changes: { name } })
    return NextResponse.json({ vendor }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/vendors error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
