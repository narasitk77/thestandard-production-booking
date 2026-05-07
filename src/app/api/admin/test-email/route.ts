import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { buildEmailErrorHint, getEmailConfigSummary, sendEmail } from '@/lib/email'
import { getValidGoogleAccessToken } from '@/lib/google-token'
import { getToken } from 'next-auth/jwt'

/**
 * Admin-only email verification endpoint.
 *
 *   POST /api/admin/test-email   { to?: string }
 *
 * Tries Gmail OAuth first, then falls back to SMTP automatically.
 * Returns actionable hints so the admin knows exactly what to fix.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const to = (body.to as string) || session.email
  const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
  const senderAccessToken = await getValidGoogleAccessToken(authToken)
  const accessTokenError = (authToken as any)?.accessTokenError

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
    const msg: string = e?.message || String(e)
    const code: string = e?.code || 'unknown'

    const hint = buildEmailErrorHint(e, accessTokenError)

    return NextResponse.json({
      error: 'Email send failed',
      detail: msg,
      code,
      hint,
      config: getEmailConfigSummary(),
    }, { status: 500 })
  }
}
