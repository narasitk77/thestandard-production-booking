import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { bookingDisplayName } from '@/lib/display'
import { logAudit } from '@/lib/audit'
import { cleanStr } from '@/lib/admin-parse'
import { EquipmentCategory } from '@prisma/client'

export const dynamic = 'force-dynamic'

const pad = (n: number) => String(n).padStart(2, '0')
function genLoanCode(): string {
  const now = new Date(Date.now() + 7 * 3_600_000) // UTC+7
  return `LOAN-${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
}

const bookingSelect = {
  id: true, status: true, deletedAt: true, assignedEmails: true, producerEmail: true, createdByEmail: true,
  shootDate: true, shootEndDate: true, projectName: true,
  program: { select: { name: true } },
  episodes: { select: { program: { select: { name: true } } } },
} as const

async function loadBooking(id: string, email: string, role?: string | null) {
  const booking = await prisma.booking.findUnique({ where: { id }, select: bookingSelect })
  if (!booking || booking.deletedAt) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!canViewBooking({ email, role }, booking)) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { booking }
}

/**
 * GET /api/bookings/[id]/equipment-request
 * Crew gear requisition for a booking they're on. Returns this booking's requests/loans
 * + the available catalog to pick from. ?q= search, ?category= filter.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { booking, error } = await loadBooking(params.id, session.email, session.role)
  if (error) return error

  const sp = new URL(request.url).searchParams
  const q = cleanStr(sp.get('q'))
  const category = (sp.get('category') || '').toUpperCase()
  const available = await prisma.equipment.findMany({
    where: {
      loanable: true, status: 'AVAILABLE',
      ...(category in EquipmentCategory ? { category: category as EquipmentCategory } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { serialNumber: { contains: q, mode: 'insensitive' } }, { itemId: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    select: { id: true, name: true, category: true, serialNumber: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    take: 200,
  })
  const requests = await prisma.equipmentLoan.findMany({
    where: { bookingId: booking!.id },
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { equipment: { select: { name: true } } } } },
  })
  return NextResponse.json({ available, requests })
}

/**
 * POST /api/bookings/[id]/equipment-request  { equipmentIds: string[] }
 * Crew requisitions gear → creates a REQUESTED loan (does NOT lock the units;
 * the gear manager checks it out in /admin/loans, which marks them ON_LOAN).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { booking, error } = await loadBooking(params.id, session.email, session.role)
    if (error) return error

    const body = await request.json().catch(() => ({}))
    const ids: string[] = Array.isArray(body.equipmentIds) ? body.equipmentIds.filter((x: unknown) => typeof x === 'string') : []
    if (ids.length === 0) return NextResponse.json({ error: 'เลือกอุปกรณ์อย่างน้อย 1 ชิ้น' }, { status: 400 })

    const eqs = await prisma.equipment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, serialNumber: true, status: true, loanable: true } })
    if (eqs.length !== ids.length) return NextResponse.json({ error: 'บางรายการไม่พบในคลัง' }, { status: 400 })
    const blocked = eqs.filter(e => !e.loanable || e.status !== 'AVAILABLE')
    if (blocked.length) return NextResponse.json({ error: `อุปกรณ์ไม่พร้อม: ${blocked.map(e => `${e.name} (${e.loanable ? e.status : 'ห้ามยืม'})`).join(', ')}` }, { status: 400 })

    const user = await prisma.user.findUnique({ where: { email: session.email }, select: { nickname: true, name: true } })
    let loanCode = genLoanCode()
    if (await prisma.equipmentLoan.findUnique({ where: { loanCode } })) loanCode = `${loanCode}-${pad(new Date().getUTCSeconds())}`

    const loan = await prisma.equipmentLoan.create({
      data: {
        loanCode,
        photographer: user?.nickname || user?.name || session.email,
        email: session.email,
        jobName: bookingDisplayName(booking!),
        bookingId: booking!.id,
        eventDate: booking!.shootDate,
        dueDate: booking!.shootEndDate || booking!.shootDate,
        status: 'REQUESTED',
        items: { create: eqs.map(e => ({ equipmentId: e.id, nameSnapshot: e.name, tagSnapshot: e.serialNumber })) },
      },
      include: { items: true },
    })
    logAudit({ actorEmail: session.email, action: 'loan.requested', entityType: 'EquipmentLoan', entityId: loan.id, changes: { bookingId: booking!.id, items: eqs.length } })
    return NextResponse.json({ loan }, { status: 201 })
  } catch (e: any) {
    console.error('POST equipment-request error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/** DELETE /api/bookings/[id]/equipment-request?loanId= — cancel one's own pending (REQUESTED) request. */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { error } = await loadBooking(params.id, session.email, session.role)
  if (error) return error
  const loanId = new URL(request.url).searchParams.get('loanId') || ''
  const loan = await prisma.equipmentLoan.findUnique({ where: { id: loanId }, select: { id: true, bookingId: true, email: true, status: true } })
  if (!loan || loan.bookingId !== params.id) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Owner can cancel only their own still-pending request; once checked out, the gear manager owns it.
  if (loan.status !== 'REQUESTED') return NextResponse.json({ error: 'เบิกแล้ว/รับของแล้ว — ยกเลิกเองไม่ได้ ติดต่อผู้ดูแลอุปกรณ์' }, { status: 400 })
  if ((loan.email || '').toLowerCase() !== session.email.toLowerCase()) return NextResponse.json({ error: 'ยกเลิกได้เฉพาะรายการของตนเอง' }, { status: 403 })
  await prisma.equipmentLoan.delete({ where: { id: loanId } })
  logAudit({ actorEmail: session.email, action: 'loan.request_cancelled', entityType: 'EquipmentLoan', entityId: loanId })
  return NextResponse.json({ ok: true })
}
