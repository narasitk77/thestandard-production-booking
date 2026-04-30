import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getEmailConfigSummary, sendEmail } from '@/lib/email'
import { getToken } from 'next-auth/jwt'

/**
 * Admin-only email verification endpoint.
 *
 *   POST /api/admin/test-email   { to?: string }
 *
 * Sends a tiny test message and returns the provider/API/SMTP error verbatim
 * so the admin can diagnose delivery without making a real booking.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const to = (body.to as string) || session.email
  const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
  const senderAccessToken = typeof authToken?.accessToken === 'string' ? authToken.accessToken : null

  try {
    const info = await sendEmail(
      {
        to,
        subject: '[Test] Production Booking — Email OK',
        text: `This is a test email from THE STANDARD Production Booking.\n\nIf you received it, email delivery is working.\n\nSent at: ${new Date().toISOString()}`,
      },
      {
        gmailAccessToken: senderAccessToken,
        gmailFrom: session.email,
      }
    )
    return NextResponse.json({
      ok: true,
      messageId: info.messageId,
      response: info.response,
      sentTo: to,
      provider: info.provider,
      config: info.config,
    })
  } catch (e: any) {
    return NextResponse.json({
      error: 'Email send failed',
      detail: e?.message || String(e),
      code: e?.code || 'unknown',
      config: getEmailConfigSummary(),
    }, { status: 500 })
  }
}
