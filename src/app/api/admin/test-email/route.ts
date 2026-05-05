import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getEmailConfigSummary, sendEmail } from '@/lib/email'
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
  const senderAccessToken = typeof authToken?.accessToken === 'string' ? authToken.accessToken : null
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

    // Build an actionable hint based on the error pattern
    let hint: string | undefined
    if (msg.includes('provider not configured') || msg.includes('not configured')) {
      hint = 'No email provider is set up. Add SMTP_USER + SMTP_PASS (Gmail App Password) to your Render environment variables, or sign out and sign in to enable Gmail OAuth.'
    } else if (msg.includes('gmail.send') || msg.includes('insufficient authentication') || msg.includes('Gmail send permission') || msg.includes('Gmail API failed')) {
      hint = 'Your Google session is missing the gmail.send permission. Sign out and sign in again — on the consent screen, allow "Send email on your behalf".'
    } else if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ESOCKET') {
      hint = `SMTP port blocked (${code}) — Render often blocks outbound SMTP. Best fix: sign out and sign in again to use Gmail OAuth instead (no SMTP needed). Or add RESEND_API_KEY to Render env vars (free at resend.com).`
    } else if (msg.includes('Invalid login') || msg.includes('Username and Password') || msg.includes('535') || msg.includes('534')) {
      hint = 'Gmail rejected the password. Use a 16-character App Password from myaccount.google.com/apppasswords — not your regular Gmail password. Or: sign out + sign in to use Gmail OAuth (no SMTP needed).'
    } else if (accessTokenError === 'RefreshAccessTokenError') {
      hint = 'Your Google session token expired. Sign out and sign in again.'
    }

    return NextResponse.json({
      error: 'Email send failed',
      detail: msg,
      code,
      hint,
      config: getEmailConfigSummary(),
    }, { status: 500 })
  }
}
