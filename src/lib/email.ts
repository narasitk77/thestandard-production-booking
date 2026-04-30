import nodemailer from 'nodemailer'

type EmailProvider = 'resend' | 'sendgrid' | 'smtp'

type EmailMessage = {
  to: string | string[]
  subject: string
  text: string
  html?: string
}

type EmailSendResult = {
  provider: EmailProvider
  messageId?: string
  response?: string
  config: ReturnType<typeof getEmailConfigSummary>
}

function getSmtpConfig() {
  // Default to 465 SSL — port 587 STARTTLS is unreliable on cloud hosts (Render etc.)
  const port = parseInt(process.env.SMTP_PORT || '465')
  // 'secure: true' means port 465 SSL/TLS; 'false' = upgrade via STARTTLS (587/25)
  const secureFlag = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465

  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: secureFlag,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Hard caps so we never hang the API thread
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  }
}

function getTransport() {
  const config = getSmtpConfig()
  return nodemailer.createTransport({
    ...config,
    auth: {
      user: config.auth.user,
      pass: config.auth.pass,
    },
  })
}

function getPreferredProvider(): EmailProvider | null {
  const configuredProvider = process.env.EMAIL_PROVIDER?.toLowerCase()
  if (configuredProvider === 'resend' || configuredProvider === 'sendgrid' || configuredProvider === 'smtp') {
    return configuredProvider
  }
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.SENDGRID_API_KEY) return 'sendgrid'
  if (process.env.SMTP_USER || process.env.SMTP_PASS) return 'smtp'
  return null
}

function getSender(provider: EmailProvider) {
  if (provider === 'smtp') {
    return process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || ''
  }
  return process.env.EMAIL_FROM ||
    process.env.RESEND_FROM ||
    process.env.SENDGRID_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    ''
}

function parseSender(sender: string) {
  const match = sender.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (!match) return { email: sender.trim() }
  return {
    name: match[1].replace(/^"|"$/g, '').trim(),
    email: match[2].trim(),
  }
}

function normalizeRecipients(to: string | string[]) {
  return (Array.isArray(to) ? to : [to]).map(email => email.trim()).filter(Boolean)
}

function assertSender(provider: EmailProvider) {
  const from = getSender(provider)
  if (!from) {
    throw new Error('EMAIL_FROM not configured')
  }
  return from
}

async function parseErrorResponse(res: Response) {
  const text = await res.text().catch(() => '')
  if (!text) return res.statusText || `HTTP ${res.status}`
  try {
    const json = JSON.parse(text)
    return json?.message || json?.error || JSON.stringify(json)
  } catch {
    return text
  }
}

async function sendViaResend(message: EmailMessage): Promise<EmailSendResult> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured')
  }
  const provider = 'resend'
  const from = assertSender(provider)
  const endpoint = process.env.RESEND_API_URL || 'https://api.resend.com/emails'

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: normalizeRecipients(message.to),
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  if (!res.ok) {
    throw new Error(`Resend API failed: ${await parseErrorResponse(res)}`)
  }

  const data = await res.json().catch(() => ({}))
  return {
    provider,
    messageId: data?.id,
    config: getEmailConfigSummary(provider),
  }
}

async function sendViaSendGrid(message: EmailMessage): Promise<EmailSendResult> {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY not configured')
  }
  const provider = 'sendgrid'
  const from = assertSender(provider)
  const sender = parseSender(from)
  const endpoint = process.env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send'
  const content = [
    { type: 'text/plain', value: message.text },
    ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
  ]

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: normalizeRecipients(message.to).map(email => ({ email })),
      }],
      from: {
        email: sender.email,
        ...(sender.name ? { name: sender.name } : {}),
      },
      subject: message.subject,
      content,
    }),
  })

  if (!res.ok) {
    throw new Error(`SendGrid API failed: ${await parseErrorResponse(res)}`)
  }

  return {
    provider,
    messageId: res.headers.get('x-message-id') || undefined,
    config: getEmailConfigSummary(provider),
  }
}

async function sendViaSmtp(message: EmailMessage): Promise<EmailSendResult> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_USER/SMTP_PASS not configured')
  }
  const provider = 'smtp'
  const transport = getTransport()
  const info = await transport.sendMail({
    from: getSender(provider),
    to: normalizeRecipients(message.to),
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
  return {
    provider,
    messageId: info.messageId,
    response: info.response,
    config: getEmailConfigSummary(provider),
  }
}

export function isEmailConfigured() {
  const provider = getPreferredProvider()
  if (!provider) return false
  if (provider === 'resend') return Boolean(process.env.RESEND_API_KEY && getSender(provider))
  if (provider === 'sendgrid') return Boolean(process.env.SENDGRID_API_KEY && getSender(provider))
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)
}

export function getEmailConfigSummary(provider = getPreferredProvider()) {
  if (provider === 'resend') {
    return {
      provider,
      from: getSender(provider) || null,
      endpoint: process.env.RESEND_API_URL || 'https://api.resend.com/emails',
    }
  }
  if (provider === 'sendgrid') {
    return {
      provider,
      from: getSender(provider) || null,
      endpoint: process.env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send',
    }
  }
  if (provider === 'smtp') {
    const config = getSmtpConfig()
    return {
      provider,
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.auth.user,
    }
  }
  return { provider: null }
}

export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  const provider = getPreferredProvider()
  if (!provider) {
    throw new Error('Email provider not configured')
  }
  if (provider === 'resend') return sendViaResend(message)
  if (provider === 'sendgrid') return sendViaSendGrid(message)
  return sendViaSmtp(message)
}

export async function sendAssignmentEmail(opts: {
  to: string
  toName: string
  bookingId: string
  outletName: string
  programName: string
  shootDate: string
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  locationName?: string | null
  producer: string
  episodes: Array<{ episodeId: string; title: string }>
  notes?: string | null
  adminNotes?: string | null
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://production-booking-app.onrender.com'

  const epList = opts.episodes.map(e => `  • ${e.episodeId} — ${e.title}`).join('\n')
  const location = opts.shootType === 'STUDIO' ? 'Studio' : opts.locationName || opts.shootType.replace('_', ' ')
  const wrapStr = opts.estimatedWrap ? ` → ${opts.estimatedWrap}` : ''

  const text = `สวัสดี ${opts.toName},

คุณได้รับมอบหมายงาน Production ใหม่:

────────────────────────────────
${opts.outletName} · ${opts.programName}
วันถ่าย: ${opts.shootDate}
เวลา: ${opts.callTime}${wrapStr}
สถานที่: ${location}
Producer: ${opts.producer}

Episode IDs:
${epList}
────────────────────────────────

${opts.adminNotes ? `หมายเหตุจาก Admin: ${opts.adminNotes}\n\n` : ''}${opts.notes ? `Notes: ${opts.notes}\n\n` : ''}ดูรายละเอียดได้ที่:
${appUrl}/dashboard/${opts.bookingId}

THE STANDARD Production Booking`

  await sendEmail({
    to: opts.to,
    subject: `[Production] ${opts.outletName} · ${opts.programName} — ${opts.shootDate}`,
    text,
    html: text.replace(/\n/g, '<br>').replace(/────+/g, '<hr>'),
  })
}

export async function sendApprovalNotification(opts: {
  producerEmail: string
  producerName: string
  bookingId: string
  outletName: string
  programName: string
  shootDate: string
  episodes: Array<{ episodeId: string; title: string }>
}) {
  if (!isEmailConfigured()) return

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://production-booking-app.onrender.com'

  const epList = opts.episodes.map(e => `  • ${e.episodeId} — ${e.title}`).join('\n')

  await sendEmail({
    to: opts.producerEmail,
    subject: `[Approved] ${opts.outletName} · ${opts.programName} — ${opts.shootDate}`,
    text: `Booking ของคุณได้รับการอนุมัติแล้ว

${opts.outletName} · ${opts.programName}
วันถ่าย: ${opts.shootDate}

Episode IDs:
${epList}

ดูรายละเอียดได้ที่: ${appUrl}/dashboard/${opts.bookingId}

THE STANDARD Production Booking`,
  })
}
