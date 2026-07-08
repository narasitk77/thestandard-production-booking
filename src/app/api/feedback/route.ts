import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { sendEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/feedback — v1.133. The floating "ติชม/แจ้งปัญหา" box (FeedbackWidget,
 * mounted globally in the root layout).
 *
 * Sends the message as an email to FEEDBACK_EMAIL (default narasit.k) with the
 * sender's identity + the page they were on, and drops an AuditLog row so
 * there's an in-app record even if the email provider hiccups.
 *
 * Any signed-in user may post. Anonymous feedback is not accepted — identity
 * is what makes a follow-up reply possible.
 */

const MOOD_LABEL: Record<string, string> = {
  love: '😊 ชอบเลย',
  problem: '😖 เจอปัญหา',
  idea: '💡 มีไอเดีย',
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const message = String(body.message || '').trim()
    const mood = typeof body.mood === 'string' && MOOD_LABEL[body.mood] ? body.mood : null
    const page = String(body.page || '').trim().slice(0, 300)

    if (!message) return NextResponse.json({ error: 'พิมพ์ข้อความก่อนส่งนะครับ' }, { status: 400 })
    if (message.length > 4000) return NextResponse.json({ error: 'ข้อความยาวเกินไป (เกิน 4,000 ตัวอักษร)' }, { status: 400 })

    const to = process.env.FEEDBACK_EMAIL?.trim() || 'narasit.k@thestandard.co'
    const moodLabel = mood ? MOOD_LABEL[mood] : '💬 ข้อความ'

    const text = `${moodLabel} จาก ${session.email}

────────────────────────────────
${message}
────────────────────────────────

หน้า: ${page || '—'}
เวลา: ${new Date().toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok' })}
ตอบกลับ: ${session.email}

Production Booking Feedback`

    // AuditLog first — the in-app record survives an email-provider outage.
    logAudit({
      actorEmail: session.email,
      action: 'feedback.submitted',
      entityType: 'Feedback',
      entityId: page || 'unknown-page',
      changes: { mood: moodLabel, message: message.slice(0, 500) },
    })

    await sendEmail({
      to,
      subject: `[Feedback] ${moodLabel} — ${session.email.split('@')[0]}`,
      text,
      html: text.replace(/\n/g, '<br>').replace(/────+/g, '<hr>'),
    })

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('POST /api/feedback error:', e)
    return NextResponse.json({ error: 'ส่งไม่สำเร็จ ลองใหม่อีกครั้งนะครับ' }, { status: 500 })
  }
}
