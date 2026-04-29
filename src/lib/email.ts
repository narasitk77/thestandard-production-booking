import nodemailer from 'nodemailer'

function getTransport() {
  // Default to 465 SSL — port 587 STARTTLS is unreliable on cloud hosts (Render etc.)
  const port = parseInt(process.env.SMTP_PORT || '465')
  // 'secure: true' means port 465 SSL/TLS; 'false' = upgrade via STARTTLS (587/25)
  const secureFlag = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465

  return nodemailer.createTransport({
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
  })
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
  if (!process.env.SMTP_USER) {
    console.warn('Email: no SMTP credentials configured')
    return
  }

  const transport = getTransport()
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
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

  await transport.sendMail({
    from,
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
  if (!process.env.SMTP_USER) return

  const transport = getTransport()
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://production-booking-app.onrender.com'

  const epList = opts.episodes.map(e => `  • ${e.episodeId} — ${e.title}`).join('\n')

  await transport.sendMail({
    from,
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
