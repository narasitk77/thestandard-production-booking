/**
 * POST /api/bookings/:id/producer-message
 *
 * A Producer sends a message about THEIR shoot to the admins:
 *   type 'update'      — extra details / update note
 *   type 'time_change' — request to change the shoot time (admin applies it)
 *
 * Records an audit-log entry and emails the active admins. We do NOT mutate the
 * booking — admins apply any time change via the normal edit flow.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const type = body?.type === 'time_change' ? 'time_change' : 'update'
    const message = String(body?.message || '').trim()
    const requestedTime = String(body?.requestedTime || '').trim()
    if (!message && !requestedTime) {
      return NextResponse.json({ error: 'Message required' }, { status: 400 })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { outlet: true, program: true },
    })
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    // v1.51 — no messages on soft-deleted bookings
    if (booking.deletedAt) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // Only the shoot's Producer (or an admin) may message about it.
    // Case-insensitive — stored producerEmail casing may differ from the session.
    if ((booking.producerEmail || '').toLowerCase() !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'You are not the producer of this booking' }, { status: 403 })
    }

    const action = type === 'time_change' ? 'booking.time_change_request' : 'booking.producer_update'
    logAudit({
      actorEmail: session.email,
      action,
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: { message: message || null, requestedTime: requestedTime || null },
    })

    // Email the active admins (best-effort).
    let emailed = 0
    if (isEmailConfigured()) {
      const admins = await prisma.user.findMany({
        where: { role: 'ADMIN', active: true },
        select: { email: true },
      })
      if (admins.length > 0) {
        const appUrl =
          process.env.NEXTAUTH_URL ||
          process.env.NEXT_PUBLIC_APP_URL ||
          'https://probook.xtec9.xyz'
        const code = booking.bookingCode || booking.id
        const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
        const heading = type === 'time_change'
          ? `[ขอแก้เวลา] ${code}`
          : `[อัปเดต] ${code}`
        const text = `${type === 'time_change' ? 'คำขอแก้ไขเวลา' : 'อัปเดตจาก Producer'}

Booking: ${code}
${booking.outlet.name} · ${booking.program.name} · ${shootDate}
เวลาเดิม: ${booking.callTime}${booking.estimatedWrap ? ` → ${booking.estimatedWrap}` : ''}
${requestedTime ? `เวลาที่ขอใหม่: ${requestedTime}\n` : ''}Producer: ${booking.producer} (${session.email})

ข้อความ:
${message || '—'}

ดูรายละเอียด: ${appUrl}/dashboard/${booking.id}

THE STANDARD Production Booking`
        try {
          await sendEmail({ to: admins.map(a => a.email), subject: heading, text })
          emailed = admins.length
        } catch (e: any) {
          console.error('[producer-message] email failed:', e?.message || e)
        }
      }
    }

    return NextResponse.json({ ok: true, emailed })
  } catch (error) {
    console.error('POST /api/bookings/[id]/producer-message error:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
