import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, inEnum } from '@/lib/admin-parse'
import { reconcileEquipmentStatus, resolveEquipmentId } from '@/lib/equipment-status'
import { LoanStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

const pad = (n: number) => String(n).padStart(2, '0')
// LOAN-YYMMDDHHMM in Bangkok time (matches the legacy sheet's id format).
function genLoanCode(): string {
  const now = new Date(Date.now() + 7 * 3_600_000) // shift to UTC+7, then read UTC parts
  return `LOAN-${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
}

/** GET /api/admin/loans — list. Query: ?status=ACTIVE|RETURNED|all */
export async function GET(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const status = (new URL(request.url).searchParams.get('status') || '').toUpperCase()
  const where: any = {}
  if (inEnum(LoanStatus, status)) where.status = status
  const loans = await prisma.equipmentLoan.findMany({
    where,
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    include: { items: { include: { equipment: { select: { id: true, name: true } } } }, documents: true },
  })
  return NextResponse.json({ loans })
}

/**
 * POST /api/admin/loans — check out gear.
 * Body: { photographer, email?, jobName?, bookingId?, eventDate?, dueDate?,
 *         items: [{ equipmentId?, nameSnapshot, tagSnapshot? }] }
 * Referenced equipment is flipped to ON_LOAN in the same transaction.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  try {
    const b = await request.json()
    const photographer = cleanStr(b.photographer)
    if (!photographer) return NextResponse.json({ error: 'photographer is required' }, { status: 400 })
    const items = Array.isArray(b.items)
      ? b.items
          .map((it: any) => ({ equipmentId: cleanStr(it.equipmentId), nameSnapshot: cleanStr(it.nameSnapshot) || cleanStr(it.name), tagSnapshot: cleanStr(it.tagSnapshot) || cleanStr(it.tag) }))
          .filter((it: any) => it.nameSnapshot)
      : []
    if (items.length === 0) return NextResponse.json({ error: 'at least one item is required' }, { status: 400 })

    // loanCode: client may pass one (import); else generate, with a seconds suffix on collision.
    let loanCode = cleanStr(b.loanCode) || genLoanCode()
    if (await prisma.equipmentLoan.findUnique({ where: { loanCode } })) loanCode = `${loanCode}-${pad(new Date().getUTCSeconds())}`

    const loan = await prisma.$transaction(async (tx) => {
      // Link each item to a real Equipment row when possible. The UI sends free
      // text only ({nameSnapshot, tagSnapshot}); resolving it to an equipmentId
      // here is what makes the AVAILABLE↔ON_LOAN status sync engage for loans
      // created in the app (previously it only worked for imported loans).
      const resolved: Array<{ equipmentId: string | null; nameSnapshot: string; tagSnapshot: string | null }> = []
      for (const it of items as any[]) {
        const equipmentId = it.equipmentId || (await resolveEquipmentId(tx, { tag: it.tagSnapshot, name: it.nameSnapshot }))
        resolved.push({ equipmentId: equipmentId || null, nameSnapshot: it.nameSnapshot, tagSnapshot: it.tagSnapshot || null })
      }
      const equipmentIds = Array.from(new Set(resolved.map((i) => i.equipmentId).filter(Boolean))) as string[]

      // Availability guard: refuse to check out gear that's not loanable,
      // already out, at the repair shop, or retired.
      if (equipmentIds.length) {
        const eqs = await tx.equipment.findMany({
          where: { id: { in: equipmentIds } },
          select: { name: true, status: true, loanable: true },
        })
        const blocked = eqs.filter((e) => !e.loanable || e.status !== 'AVAILABLE')
        if (blocked.length) {
          const detail = blocked.map((e) => `${e.name} (${!e.loanable ? 'ห้ามยืม' : e.status})`).join(', ')
          throw new Error(`BLOCKED:ยืมไม่ได้ — อุปกรณ์ไม่พร้อม: ${detail}`)
        }
      }

      const created = await tx.equipmentLoan.create({
        data: {
          loanCode,
          photographer,
          email: cleanStr(b.email),
          jobName: cleanStr(b.jobName),
          bookingId: cleanStr(b.bookingId),
          eventDate: dateOrNull(b.eventDate),
          dueDate: dateOrNull(b.dueDate),
          borrowedAt: dateOrNull(b.borrowedAt) || new Date(),
          status: 'ACTIVE',
          items: { create: resolved.map((it) => ({ equipmentId: it.equipmentId, nameSnapshot: it.nameSnapshot, tagSnapshot: it.tagSnapshot })) },
        },
        include: { items: true },
      })
      // Derive ON_LOAN (and anything else) from the live world.
      await reconcileEquipmentStatus(tx, equipmentIds)
      return created
    })
    logAudit({ actorEmail: session.email, action: 'loan.create', entityType: 'EquipmentLoan', entityId: loan.id, changes: { loanCode, photographer, items: items.length } })
    return NextResponse.json({ loan }, { status: 201 })
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg.startsWith('BLOCKED:')) return NextResponse.json({ error: msg.slice('BLOCKED:'.length) }, { status: 409 })
    console.error('POST /api/admin/loans error:', e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
