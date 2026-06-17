// Notification dispatch for the reminder engine.
//
// Two channels today:
//   - Discord: a single incoming-webhook POST. No SDK, no bot, no token dance.
//   - Email:   the existing sendEmail() (Resend / SendGrid / SMTP). Note the
//              background worker has no logged-in user, so Gmail-OAuth is NOT
//              available here — a non-interactive provider (SMTP_USER/PASS or
//              RESEND_API_KEY / SENDGRID_API_KEY) must be set for email to send.
//
// LINE is a deliberate TODO: LINE Notify was shut down Mar 2025, so it needs a
// Messaging-API bot. The channel seam lives here so adding it later is one
// function (notifyLine) wired into reminders.ts — nothing else changes.
import { sendEmail, isEmailConfigured } from './email'

/** POST a message to the configured Discord webhook. Returns false (not throw) when unset/failed. */
export async function notifyDiscord(content: string): Promise<boolean> {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim()
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Discord hard-caps a single message body at 2000 chars.
      body: JSON.stringify({ content: content.slice(0, 1990) }),
    })
    if (!res.ok) {
      console.error(`[notify] discord ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
      return false
    }
    return true
  } catch (err: any) {
    console.error('[notify] discord failed:', err?.message || err)
    return false
  }
}

/** Send the daily digest email to REMINDER_ADMIN_EMAIL. Best-effort. */
export async function notifyEmailDigest(subject: string, text: string): Promise<boolean> {
  const to = process.env.REMINDER_ADMIN_EMAIL?.trim() || process.env.EMAIL_FROM?.trim()
  if (!to) return false
  if (!isEmailConfigured()) {
    console.warn('[notify] email digest skipped — no non-interactive email provider configured (SMTP/Resend/SendGrid).')
    return false
  }
  try {
    await sendEmail({ to, subject, text })
    return true
  } catch (err: any) {
    console.error('[notify] email digest failed:', err?.message || err)
    return false
  }
}
