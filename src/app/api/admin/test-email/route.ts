import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import nodemailer from 'nodemailer'

/**
 * Admin-only SMTP verification endpoint.
 *
 *   POST /api/admin/test-email   { to?: string }
 *
 * Sends a tiny test message and returns success or the SMTP error verbatim
 * so the admin can diagnose Gmail App Password / port issues without making
 * a real booking.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const to = (body.to as string) || session.email

  if (!process.env.SMTP_USER) {
    return NextResponse.json({ error: 'SMTP_USER not configured' }, { status: 500 })
  }

  const port = parseInt(process.env.SMTP_PORT || '465')
  const secureFlag = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465

  const config = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: secureFlag,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  }

  const transport = nodemailer.createTransport(config)

  try {
    await transport.verify()
  } catch (e: any) {
    return NextResponse.json({
      error: 'SMTP verify failed',
      detail: e?.message || String(e),
      code: e?.code || 'unknown',
      config: { host: config.host, port: config.port, secure: config.secure, user: config.auth.user },
    }, { status: 500 })
  }

  try {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: '[Test] Production Booking — SMTP OK',
      text: `This is a test email from THE STANDARD Production Booking.\n\nIf you received it, SMTP is working.\n\nSent at: ${new Date().toISOString()}`,
    })
    return NextResponse.json({
      ok: true,
      messageId: info.messageId,
      response: info.response,
      sentTo: to,
      config: { host: config.host, port: config.port, secure: config.secure, user: config.auth.user },
    })
  } catch (e: any) {
    return NextResponse.json({
      error: 'SMTP sendMail failed',
      detail: e?.message || String(e),
      code: e?.code || 'unknown',
      config: { host: config.host, port: config.port, secure: config.secure, user: config.auth.user },
    }, { status: 500 })
  }
}
