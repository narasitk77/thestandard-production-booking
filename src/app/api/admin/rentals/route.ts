import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { cleanStr, dateOrNull, decOrNull, inEnum } from '@/lib/admin-parse'
import { PaymentStatus, RentalStatus } from '@prisma/client'
import { resolveOutletId } from '@/lib/rental-helpers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/rentals — list. Query: ?status=ACTIVE|RETURNED|ARCHIVED|all,
 * ?payment=PAID|INVOICED|PENDING.
 */
export async function GET(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  const sp = new URL(request.url).searchParams
  const status = (sp.get('status') || '').toUpperCase()
  const payment = (sp.get('payment') || '').toUpperCase()
  const outlet = (sp.get('outlet') || '').trim()
  const year = parseInt(sp.get('year') || '', 10)
  const month = parseInt(sp.get('month') || '', 10)
  const where: any = {}
  if (inEnum(RentalStatus, status)) where.status = status
  if (inEnum(PaymentStatus, payment)) where.paymentStatus = payment
  if (outlet && outlet !== 'all') where.outlet = { code: outlet }
  // Year / month filter on rentalDate — month is within the chosen year, mirroring
  // the sheet's per-year monthly tabs. Rows with no rentalDate fall out of a dated
  // filter (expected).
  if (year && !Number.isNaN(year)) {
    const m = month >= 1 && month <= 12 ? month : 0
    const start = new Date(Date.UTC(year, m ? m - 1 : 0, 1))
    const end = m ? new Date(Date.UTC(year, m, 1)) : new Date(Date.UTC(year + 1, 0, 1))
    where.rentalDate = { gte: start, lt: end }
  }
  const rentals = await prisma.rentalJob.findMany({
    where,
    orderBy: [{ rentalDate: 'desc' }],
    include: {
      vendor: { select: { id: true, name: true } },
      outlet: { select: { code: true, name: true } },
      booking: { select: { id: true, bookingCode: true, shootDate: true } },
      documents: true,
    },
  })
  return NextResponse.json({ rentals })
}

/** POST /api/admin/rentals — create (ADMIN: money). */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only (finance)' }, { status: 403 })
  try {
    const b = await request.json()
    const payment = inEnum(PaymentStatus, b.paymentStatus) ? b.paymentStatus : 'PENDING'
    const status = inEnum(RentalStatus, b.status) ? b.status : 'ACTIVE'
    const rental = await prisma.rentalJob.create({
      data: {
        quoteNo: cleanStr(b.quoteNo),
        adType: cleanStr(b.adType),
        jobName: cleanStr(b.jobName),
        bookingId: cleanStr(b.bookingId),
        outletId: await resolveOutletId(b.outletId),
        vendorId: cleanStr(b.vendorId),
        rentalDate: dateOrNull(b.rentalDate),
        returnDueDate: dateOrNull(b.returnDueDate),
        returnedAt: dateOrNull(b.returnedAt),
        paymentStatus: payment,
        invoiceNo: cleanStr(b.invoiceNo),
        amount: decOrNull(b.amount),
        status,
        remark: cleanStr(b.remark),
      },
    })
    logAudit({ actorEmail: session.email, action: 'rental.create', entityType: 'RentalJob', entityId: rental.id, changes: { jobName: rental.jobName, amount: b.amount } })
    return NextResponse.json({ rental }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/rentals error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
