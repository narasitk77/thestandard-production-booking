import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, requireConsole } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bookings/[id]/rentals — the rental jobs linked to this booking, for
 * the "งานเช่า" section on the booking detail page + calendar drawer.
 *
 * CONSOLE-ONLY on purpose: rental data is finance (vendor, amount, invoices), and
 * a plain booking is viewable by its producer/crew (canViewBooking). Keeping this
 * off /api/bookings/[id] means that view never leaks rental money to non-console
 * users. Returns amount as a number (Decimal → JSON) and only the doc KINDS the
 * card needs to compute "เอกสารครบ/ขาด".
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await requireConsole())) return NextResponse.json({ error: 'Console only' }, { status: 403 })

  const rentals = await prisma.rentalJob.findMany({
    where: { bookingId: params.id },
    orderBy: [{ rentalDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true, jobName: true, quoteNo: true, invoiceNo: true, adType: true,
      paymentStatus: true, status: true, amount: true,
      rentalDate: true, returnDueDate: true, returnedAt: true,
      vendor: { select: { id: true, name: true } },
      outlet: { select: { code: true } },
      documents: { select: { kind: true } },
    },
  })

  return NextResponse.json({
    rentals: rentals.map(r => ({
      ...r,
      amount: r.amount == null ? null : Number(r.amount),
    })),
  })
}
