import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { isMyBooking } from '@/lib/my-bookings-scope'
import { logAudit } from '@/lib/audit'
import { isEmailConfigured } from '@/lib/email'
import { notifyEmailEach } from '@/lib/notify'
import { alertOps } from '@/lib/ops-alert'

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
 * Someone asks to cancel — this does NOT cancel the booking, it flags it
 * (cancelRequestedAt) so staff/Tui review it in the "ขอยกเลิก" tab. Emails the
 * notify list; a request that mailed nobody raises an ops alert. Reason is required.
 *
 * Who may file: any signed-in user (canViewBooking — prod behaviour since v1.152).
 * Limiting it to people on the booking is Nat's decision, not made yet. Until then
 * a filer who is NOT on the booking is made visible instead of refused: the audit
 * row and the managers' email say so, and a request that replaces an earlier one
 * keeps the earlier reason/requester in the audit row.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true, bookingCode: true, status: true, createdByEmail: true, producerEmail: true, coProducerEmail: true,
        assignedEmails: true, producer: true, shootDate: true, callTime: true, deletedAt: true,
        cancelRequestedAt: true, cancelReason: true, cancelRequestedBy: true,
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
    const onBooking = isMyBooking(booking, session.email)
    const previous = booking.cancelRequestedAt
      ? { reason: booking.cancelReason, by: booking.cancelRequestedBy, at: booking.cancelRequestedAt }
      : null

    // Notify Tui / managers — never blocks the request, but never silent either.
    // 2026-11-23: on prod CANCEL_NOTIFY_EMAIL was empty and there is no MANAGER user, so every request since
    // (at least) 22 Oct mailed nobody, with no log line — `if (to.length)` skipped quietly and allSettled threw the
    // results away. Who receives it is unchanged (Nat's decision); what changed is that "nobody was told" is now
    // an ops alert, and the audit row says who was mailed (recipients) and who was not (failedRecipients).
    const code = booking.bookingCode || booking.id
    const date = booking.shootDate ? new Date(booking.shootDate).toISOString().slice(0, 10) : '—'
    const link = process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL.replace(/\/$/, '')}/admin?cancel=${booking.id}` : ''
    const subject = `[ขอยกเลิกงาน] ${code} — ${booking.outlet.code} ${booking.program.name}`
    const who = onBooking ? '' : `\n⚠️ ผู้ขอไม่ได้อยู่ในรายชื่อของงานนี้ (ไม่ใช่ผู้จอง / Producer / Co-Producer / ทีมที่ได้รับมอบหมาย) — ตรวจกับ Producer ก่อนยกเลิกจริง\n`
    const replaced = previous ? `\n(แทนคำขอเดิมของ ${previous.by || '—'}: ${previous.reason || '—'})\n` : ''
    const text = `${session.email} ขอยกเลิกงาน\n${who}${replaced}\nงาน: ${code} (${booking.outlet.name} · ${booking.program.name})\nวันถ่าย: ${date} ${booking.callTime}\nProducer: ${booking.producer}\nสถานะปัจจุบัน: ${booking.status}\n\nเหตุผล: ${reason}\n${link ? `\nเปิดดู: ${link}` : ''}`
    let to: string[] = []
    let mail: { sent: string[]; failed: string[] } = { sent: [], failed: [] }
    let why = ''
    try {
      to = await notifyEmails()
      // one message per recipient — don't expose the manager list in a flat To:
      mail = await notifyEmailEach(to, subject, text)
    } catch (e: any) {
      why = `หาผู้รับไม่ได้: ${e?.message || e}`
    }
    if (!mail.sent.length) {
      why ||= !to.length ? 'ไม่มีผู้รับ — CANCEL_NOTIFY_EMAIL ว่าง และไม่มีผู้ใช้ role MANAGER ที่ active'
        : !isEmailConfigured() ? 'ยังไม่ได้ตั้งผู้ให้บริการอีเมล (SMTP/Resend/SendGrid)'
        : `ส่งไม่สำเร็จทุกคน: ${mail.failed.join(', ')}`
      console.error(`[request-cancel] ${code}: เมลแจ้งขอยกเลิกไม่ถึงใครเลย — ${why}`)
      await alertOps('cancel-request-unnotified', `คำขอยกเลิกงานไม่ถึงผู้ประสานงาน — ${code}`,
        `${code}: เมลแจ้ง "ขอยกเลิกงาน" ไม่ถึงใครเลย — ${why}\n`
        + 'คำขอถูกบันทึกแล้วและอยู่ในแท็บ "ขอยกเลิก" ที่ /admin แต่ไม่มีใครได้เมล — ต้องมีคนเปิดดูเอง'
        + ' (เตือนนี้ไม่ซ้ำภายใน 6 ชม. — คำขอถัดไปในช่วงนั้นดูได้ในแท็บเดียวกัน)\n\n' + text)
    }
    logAudit({
      actorEmail: session.email, action: 'booking.cancel_requested', entityType: 'Booking', entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: {
        reason, requestedBy: session.email, onBooking, ...(previous ? { replaced: previous } : {}),
        recipients: to, failedRecipients: mail.failed,
      },
    })

    return NextResponse.json({ ok: true, booking: updated })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/request-cancel error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
