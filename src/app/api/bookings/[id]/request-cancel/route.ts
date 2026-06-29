import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'

export const dynamic = 'force-dynamic'

/** Who gets the "cancellation requested" email: env (Tui), else active MANAGER users. */
async function notifyEmails(): Promise<string[]> {
  const env = (process.env.CANCEL_NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean)
  if (env.length) return env
  const managers = await prisma.user.findMany({ where: { role: 'MANAGER', active: true }, select: { email: true } })
  return managers.map(m => m.email)
}

/**
 * POST /api/bookings/[id]/request-cancel  { reason }
 * The booking owner/producer/assigned crew (or staff) asks to cancel — this does
 * NOT cancel the booking, it flags it (cancelRequestedAt) so staff/Tui review it
 * in the "ขอยกเลิก" tab. Emails the notify list. Reason is required.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true, bookingCode: true, status: true, createdByEmail: true, producerEmail: true,
        assignedEmails: true, producer: true, shootDate: true, callTime: true, deletedAt: true,
        outlet: { select: { code: true, name: true } }, program: { select: { name: true } },
      },
    })
    if (!booking || booking.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') {
      return NextResponse.json({ error: 'งานนี้ปิดแล้ว — ขอยกเลิกไม่ได้' }, { status: 400 })
    }

    const reason = String((await request.json().catch(() => ({})))?.reason || '').trim()
    if (!reason) return NextResponse.json({ error: 'กรุณาระบุเหตุผลที่ขอยกเลิก' }, { status: 400 })

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { cancelRequestedAt: new Date(), cancelReason: reason.slice(0, 1000), cancelRequestedBy: session.email },
      select: { id: true, cancelRequestedAt: true, cancelReason: true, cancelRequestedBy: true },
    })
    logAudit({ actorEmail: session.email, action: 'booking.cancel_requested', entityType: 'Booking', entityId: booking.id, changes: { reason } })

    // Notify Tui / managers — best-effort, never block the request.
    try {
      if (isEmailConfigured()) {
        const to = await notifyEmails()
        if (to.length) {
          const code = booking.bookingCode || booking.id
          const date = booking.shootDate ? new Date(booking.shootDate).toISOString().slice(0, 10) : '—'
          const link = process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL.replace(/\/$/, '')}/admin?cancel=${booking.id}` : ''
          const subject = `[ขอยกเลิกงาน] ${code} — ${booking.outlet.code} ${booking.program.name}`
          const text = `${session.email} ขอยกเลิกงาน\n\nงาน: ${code} (${booking.outlet.name} · ${booking.program.name})\nวันถ่าย: ${date} ${booking.callTime}\nProducer: ${booking.producer}\nสถานะปัจจุบัน: ${booking.status}\n\nเหตุผล: ${reason}\n${link ? `\nเปิดดู: ${link}` : ''}`
          // one message per recipient — don't expose the manager list in a flat To:
          await Promise.allSettled(to.map(addr => sendEmail({ to: [addr], subject, text })))
        }
      }
    } catch (e) { console.error('request-cancel: email failed (continuing):', e) }

    return NextResponse.json({ ok: true, booking: updated })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/request-cancel error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
