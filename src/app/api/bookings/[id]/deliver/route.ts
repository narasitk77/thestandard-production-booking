import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { buildFootageReport, renderReportText, formatBytes } from '@/lib/footage-report'
import { bookingDisplayName } from '@/lib/display'

export const dynamic = 'force-dynamic'

/**
 * POST /api/bookings/:id/deliver
 *
 * v1.89 — the crew member presses "ส่งงาน" once footage is uploaded. Emails the
 * Producer (+ CCs the sender) a file report and records the delivery. Re-send is
 * allowed (e.g. after uploading more) — we keep only the latest deliveredAt.
 * User-initiated (not autonomous) so the outbound email is a deliberate action.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true, bookingCode: true, status: true, assignedEmails: true, deletedAt: true,
        producer: true, producerEmail: true, projectName: true, category: true,
        callTime: true, shootDate: true,
        outlet: { select: { name: true } },
        program: { select: { name: true } },
        episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { name: true } } } },
      },
    })
    if (!booking || booking.deletedAt) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    const check = await canUploadToBooking(session.email, {
      id: booking.id, status: booking.status, assignedEmails: booking.assignedEmails,
    })
    if (!check.ok && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'คุณไม่ได้รับมอบหมายงานนี้', code: check.reason ?? 'FORBIDDEN' }, { status: 403 })
    }

    const report = await buildFootageReport(booking.id)
    if (report.totalFiles === 0) {
      return NextResponse.json({ error: 'ยังไม่มีไฟล์ที่อัปโหลด — อัปก่อนแล้วค่อยส่งงาน' }, { status: 400 })
    }

    const producerEmail = (booking.producerEmail || '').trim()
    // Producer + the sender (CC self). De-dupe case-insensitively.
    const recipients = Array.from(new Set(
      [producerEmail, session.email].filter(Boolean).map(e => e.toLowerCase()),
    ))

    const show = bookingDisplayName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes })
    const code = booking.bookingCode || booking.id
    const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'

    let emailed = 0
    let emailError: string | null = null
    if (isEmailConfigured()) {
      const subject = `[ส่งงาน] ${code} — ${show}`
      const text = `ส่งงาน footage เรียบร้อย — ${code}
${booking.outlet.name} · ${show} · ${shootDate} ${booking.callTime}
ส่งโดย: ${session.email}
${producerEmail ? `Producer: ${booking.producer || ''} (${producerEmail})` : '⚠️ งานนี้ไม่มีอีเมล Producer ในระบบ'}

— รายงานไฟล์ —
${renderReportText(report)}

เปิดดูในระบบ: ${appUrl}/upload?bookingId=${booking.id}

THE STANDARD Production Booking`
      try {
        await sendEmail({ to: recipients, subject, text })
        emailed = recipients.length
      } catch (e: any) {
        emailError = e?.message || String(e)
        console.error('[deliver] email failed:', emailError)
      }
    }

    await prisma.booking.update({
      where: { id: booking.id },
      data: { deliveredAt: new Date(), deliveredBy: session.email },
    })
    logAudit({
      actorEmail: session.email,
      action: 'booking.delivered',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: { totalFiles: report.totalFiles, totalSize: formatBytes(report.totalBytes), recipients, emailError },
    })

    return NextResponse.json({
      ok: true,
      emailed,
      recipients,
      totalFiles: report.totalFiles,
      producerMissing: !producerEmail,
      emailConfigured: isEmailConfigured(),
      emailError,
    })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/deliver error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
