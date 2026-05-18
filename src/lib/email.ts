import nodemailer from 'nodemailer'

type EmailProvider = 'resend' | 'sendgrid' | 'gmail-oauth' | 'smtp'

type EmailMessage = {
  to: string | string[]
  subject: string
  text: string
  html?: string
}

type EmailContext = {
  gmailAccessToken?: string | null
  gmailFrom?: string | null
}

type EmailSendResult = {
  provider: EmailProvider
  messageId?: string
  response?: string
  config: ReturnType<typeof getEmailConfigSummary>
}

function getSmtpConfig() {
  const port = parseInt(process.env.SMTP_PORT || '587')
  // secure:true = SSL/TLS (port 465); false = STARTTLS (port 587)
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
    tls: { rejectUnauthorized: false },
    // Fail fast — if the port is blocked on Render these will never succeed
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
  }
}

function getTransport() {
  return nodemailer.createTransport(getSmtpConfig())
}

function getPreferredProvider(context: EmailContext = {}): EmailProvider | null {
  const configuredProvider = process.env.EMAIL_PROVIDER?.toLowerCase()
  if (
    configuredProvider === 'resend' ||
    configuredProvider === 'sendgrid' ||
    configuredProvider === 'gmail-oauth' ||
    configuredProvider === 'gmail' ||
    configuredProvider === 'smtp'
  ) {
    if (configuredProvider === 'gmail') return 'gmail-oauth'
    return configuredProvider
  }
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.SENDGRID_API_KEY) return 'sendgrid'
  if (context.gmailAccessToken) return 'gmail-oauth'
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

function encodeHeader(value: string) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function toBase64Url(value: string) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function buildMime(message: EmailMessage, from: string) {
  const recipients = normalizeRecipients(message.to)
  if (recipients.length === 0) {
    throw new Error('Email recipient not configured')
  }

  const boundary = `production-booking-${Date.now()}`
  const html = message.html || message.text.replace(/\n/g, '<br>')

  return [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function sendViaGmailOAuth(message: EmailMessage, context: EmailContext): Promise<EmailSendResult> {
  if (!context.gmailAccessToken) {
    throw new Error('Google Gmail send permission missing. Sign out and sign in again, then allow Gmail send access.')
  }
  const provider = 'gmail-oauth'
  const from = context.gmailFrom || process.env.EMAIL_FROM || process.env.SMTP_FROM || ''
  if (!from) {
    throw new Error('Google sender email not available')
  }
  const raw = toBase64Url(buildMime(message, from))

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${context.gmailAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!res.ok) {
    throw new Error(`Gmail API failed: ${await parseErrorResponse(res)}`)
  }

  const data = await res.json().catch(() => ({}))
  return {
    provider,
    messageId: data?.id,
    config: getEmailConfigSummary(provider),
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

export function buildEmailErrorHint(error: any, accessTokenError?: string | null): string | undefined {
  const msg: string = error?.message || String(error || '')
  const code: string = error?.code || 'unknown'
  if (msg.includes('provider not configured') || msg.includes('not configured')) {
    return 'No email provider is set up. Add SMTP_USER + SMTP_PASS (Gmail App Password) to your Render environment variables, or sign out and sign in to enable Gmail OAuth.'
  }
  if (msg.includes('gmail.send') || msg.includes('insufficient authentication') || msg.includes('Gmail send permission') || msg.includes('Gmail API failed')) {
    return 'Your Google session is missing the gmail.send permission. Sign out and sign in again — on the consent screen, allow "Send email on your behalf".'
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ESOCKET') {
    return `SMTP port blocked (${code}) — Render often blocks outbound SMTP. Best fix: sign out and sign in again to use Gmail OAuth instead. Or add RESEND_API_KEY to Render env vars (free at resend.com).`
  }
  if (msg.includes('Invalid login') || msg.includes('Username and Password') || msg.includes('535') || msg.includes('534')) {
    return 'Gmail rejected the password. Use a 16-character App Password from myaccount.google.com/apppasswords — not your regular Gmail password. Or: sign out + sign in to use Gmail OAuth.'
  }
  if (accessTokenError === 'RefreshAccessTokenError') {
    return 'Your Google session token expired. Sign out and sign in again.'
  }
  return undefined
}

export function isEmailConfigured(context: EmailContext = {}) {
  const provider = getPreferredProvider(context)
  if (!provider) return false
  if (provider === 'resend') return Boolean(process.env.RESEND_API_KEY && getSender(provider))
  if (provider === 'sendgrid') return Boolean(process.env.SENDGRID_API_KEY && getSender(provider))
  if (provider === 'gmail-oauth') return Boolean(context.gmailAccessToken)
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
  if (provider === 'gmail-oauth') {
    return { provider }
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

export async function sendEmail(message: EmailMessage, context: EmailContext = {}): Promise<EmailSendResult> {
  const provider = getPreferredProvider(context)
  if (!provider) {
    throw new Error('Email provider not configured. Set SMTP_USER + SMTP_PASS in Render environment variables, or configure RESEND_API_KEY / SENDGRID_API_KEY.')
  }
  if (provider === 'resend') return sendViaResend(message)
  if (provider === 'sendgrid') return sendViaSendGrid(message)

  // Gmail OAuth: if it fails (e.g. token lacks gmail.send scope), fall back to SMTP
  if (provider === 'gmail-oauth') {
    try {
      return await sendViaGmailOAuth(message, context)
    } catch (oauthErr: any) {
      console.warn('Gmail OAuth send failed, falling back to SMTP:', oauthErr?.message)
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        return sendViaSmtp(message)
      }
      throw oauthErr
    }
  }

  return sendViaSmtp(message)
}

export async function sendAssignmentEmail(opts: {
  to: string
  toName: string
  bookingId: string
  outletName: string
  programName: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  locationName?: string | null
  producer: string
  episodes: Array<{ episodeId: string; title: string }>
  notes?: string | null
  adminNotes?: string | null
  senderAccessToken?: string | null
  senderEmail?: string | null
  calendarUrl?: string | null
}) {
  // NEXTAUTH_URL is a normal runtime env (NEXT_PUBLIC_* gets inlined at build
  // time, so it can't reflect the real deployment URL). Prefer it.
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://production-booking-app.onrender.com'
  const detailLink = opts.calendarUrl || `${appUrl}/dashboard/${opts.bookingId}`

  const epList = opts.episodes.map(e => `  • ${e.episodeId} — ${e.title}`).join('\n')
  const location = opts.shootType === 'STUDIO' ? 'Studio' : opts.locationName || opts.shootType.replace('_', ' ')
  const wrapStr = opts.estimatedWrap ? ` → ${opts.estimatedWrap}` : ''
  const dateStr = opts.shootEndDate && opts.shootEndDate !== opts.shootDate
    ? `${opts.shootDate} → ${opts.shootEndDate}`
    : opts.shootDate

  const text = `สวัสดี ${opts.toName},

คุณได้รับมอบหมายงาน Production ใหม่:

────────────────────────────────
${opts.outletName} · ${opts.programName}
วันถ่าย: ${dateStr}
เวลา: ${opts.callTime}${wrapStr}
สถานที่: ${location}
Producer: ${opts.producer}

Episode IDs:
${epList}
────────────────────────────────

${opts.adminNotes ? `หมายเหตุจาก Admin: ${opts.adminNotes}\n\n` : ''}${opts.notes ? `Notes: ${opts.notes}\n\n` : ''}${opts.calendarUrl ? 'เปิดงานนี้ใน Google Calendar:' : 'ดูรายละเอียดได้ที่:'}
${detailLink}

THE STANDARD Production Booking`

  await sendEmail(
    {
      to: opts.to,
      subject: `[Production] ${opts.outletName} · ${opts.programName} — ${opts.shootDate}`,
      text,
      html: text.replace(/\n/g, '<br>').replace(/────+/g, '<hr>'),
    },
    {
      gmailAccessToken: opts.senderAccessToken,
      gmailFrom: opts.senderEmail,
    }
  )
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

  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://production-booking-app.onrender.com'

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
