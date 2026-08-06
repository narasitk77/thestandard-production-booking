/**
 * GET  /api/feedback/tickets/:id — the thread (reporter or console only)
 * POST /api/feedback/tickets/:id — reply, and/or change status (console only)
 *
 * Authorisation is per-ticket: a normal user reaches their OWN thread and
 * nothing else, so guessing an id gets a 404-shaped refusal, not someone
 * else's conversation.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import {
  ticketRef, isFeedbackStatus, STATUS_TH, type FeedbackStatus,
  statusAfterAdminReply, statusAfterReporterReply,
} from '@/lib/feedback'

export const dynamic = 'force-dynamic'

async function loadVisible(id: string, email: string, admin: boolean) {
  const t = await prisma.feedbackTicket.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!t) return null
  if (!admin && t.reporterEmail !== email) return null
  return t
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const t = await loadVisible(params.id, session.email, hasConsoleAccess(session.role))
  if (!t) return NextResponse.json({ error: 'ไม่พบเรื่องนี้' }, { status: 404 })
  return NextResponse.json({ ticket: t, admin: hasConsoleAccess(session.role) })
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = hasConsoleAccess(session.role)

  const t = await loadVisible(params.id, session.email, admin)
  if (!t) return NextResponse.json({ error: 'ไม่พบเรื่องนี้' }, { status: 404 })

  const body = await request.json().catch(() => ({} as any))
  const text = String(body?.body || '').trim()
  const nextStatus: unknown = body?.status
  const resolution = typeof body?.resolution === 'string' ? body.resolution.trim() : null

  if (nextStatus !== undefined && !admin) {
    return NextResponse.json({ error: 'เปลี่ยนสถานะได้เฉพาะทีมแอดมิน' }, { status: 403 })
  }
  if (nextStatus !== undefined && !isFeedbackStatus(nextStatus)) {
    return NextResponse.json({ error: 'สถานะไม่ถูกต้อง' }, { status: 400 })
  }
  if (!text && nextStatus === undefined) {
    return NextResponse.json({ error: 'พิมพ์ข้อความ หรือเลือกสถานะก่อนส่ง' }, { status: 400 })
  }
  if (text.length > 4000) return NextResponse.json({ error: 'ข้อความยาวเกินไป' }, { status: 400 })

  const now = new Date()
  const status: FeedbackStatus = nextStatus !== undefined && isFeedbackStatus(nextStatus)
    ? nextStatus
    : (text
        ? (admin ? statusAfterAdminReply(t.status) : statusAfterReporterReply(t.status))
        : (isFeedbackStatus(t.status) ? t.status : 'NEW'))

  const updated = await prisma.$transaction(async (tx) => {
    if (text) {
      await tx.feedbackMessage.create({
        data: { ticketId: t.id, authorEmail: session.email, fromAdmin: admin, body: text },
      })
    }
    return tx.feedbackTicket.update({
      where: { id: t.id },
      data: {
        status,
        ...(text ? { lastMessageAt: now } : {}),
        // Stamp the closure ONLY on the transition into RESOLVED. Without the
        // `t.status !== 'RESOLVED'` half, an admin replying to an already-closed
        // ticket silently moved resolvedAt/resolvedBy to themselves and to now.
        ...(status === 'RESOLVED' && t.status !== 'RESOLVED'
          ? { resolvedAt: now, resolvedBy: session.email, ...(resolution ? { resolution } : {}) }
          : {}),
        // Reopening clears the whole closure — a stale "แก้เสร็จ: …" line on a
        // ticket that is open again is worse than no line.
        ...(status !== 'RESOLVED' && t.status === 'RESOLVED'
          ? { resolvedAt: null, resolvedBy: null, resolution: null }
          : {}),
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
  })

  logAudit({
    actorEmail: session.email,
    action: 'feedback.reply',
    entityType: 'FeedbackTicket',
    entityId: t.id,
    changes: { ref: ticketRef(t.number), from: t.status, to: status, replied: !!text },
  })

  // Notify the other side. Best-effort — the thread is already saved.
  if (isEmailConfigured()) {
    try {
      const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
      const ref = ticketRef(t.number)
      const to = admin ? t.reporterEmail : (process.env.FEEDBACK_EMAIL?.trim() || 'narasit.k@thestandard.co')
      const closed = status === 'RESOLVED' && t.status !== 'RESOLVED'
      const subject = closed
        ? `[${ref}] แก้เสร็จแล้ว — ${t.subject}`
        : `[${ref}] มีข้อความใหม่ — ${t.subject}`
      const lines = [
        closed ? 'เรื่องที่คุณแจ้งไว้แก้เสร็จแล้วครับ 🎉' : 'มีข้อความใหม่ในเรื่องที่คุณแจ้งไว้',
        '',
        `เรื่อง: ${t.subject}`,
        `สถานะ: ${STATUS_TH[status]}`,
        ...(closed && (resolution || t.resolution) ? ['', `สรุปที่แก้: ${resolution || t.resolution}`] : []),
        ...(text ? ['', '────────────', text, '────────────'] : []),
        '',
        `ดู/ตอบกลับ: ${appUrl}${admin ? '/feedback' : '/admin/feedback'}`,
        '',
        'THE STANDARD Production Booking',
      ]
      await sendEmail({ to, subject, text: lines.join('\n') })
    } catch (e: any) {
      console.error('[feedback] reply email failed:', e?.message || e)
    }
  }

  return NextResponse.json({ ok: true, ticket: updated })
}
