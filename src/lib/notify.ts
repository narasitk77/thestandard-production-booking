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

/**
 * v1.152.2 — Discord carries FOOTAGE news only (ops decision 2026-07-23:
 * "แจ้งเตือนแค่เรื่องไฟล์พอ"). The channel is where the crew watches for
 * footage landing; mixing in overdue-rental reminders and worker-health
 * alerts trained people to scroll past it, which defeats the one thing it is
 * good at. Those still go to email, where they belong.
 *
 *   'footage' — files moved / footage ready / NAS sync drained
 *   'ops'     — reminders, worker-down alerts, anything not about files
 *
 * v1.156 note: urgent-booking alerts deliberately do NOT post to Discord —
 * the channel stays footage-only (ops decision 2026-07-28); they go by email
 * (notifyEmail below) instead.
 *
 * Set DISCORD_NOTIFY_SCOPE=all to put the ops chatter back on Discord.
 */
export type NotifyCategory = 'footage' | 'ops'

function discordAllows(category: NotifyCategory): boolean {
  if (category === 'footage') return true
  return (process.env.DISCORD_NOTIFY_SCOPE || 'footage').trim().toLowerCase() === 'all'
}

/**
 * POST a message to the configured Discord webhook. Returns false (not throw)
 * when unset, filtered out by scope, or failed.
 *
 * Callers that treat the return value as "the human was told" (footage-ready
 * uses it as an email fallback) must pass 'footage', which is never filtered.
 */
export async function notifyDiscord(content: string, category: NotifyCategory = 'footage'): Promise<boolean> {
  if (!discordAllows(category)) return false
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

/**
 * Email a SPECIFIC recipient (e.g. the coordinator for an urgent booking), not
 * the fixed admin digest address. Best-effort: false when no recipient, email
 * unconfigured, or send failed — never throws (callers fire-and-forget). One
 * message per address so recipients aren't exposed to each other in a flat To:.
 */
export async function notifyEmail(to: string | string[], subject: string, text: string): Promise<boolean> {
  const list = (Array.isArray(to) ? to : [to]).map(s => s.trim()).filter(Boolean)
  if (!list.length) return false
  if (!isEmailConfigured()) {
    console.warn('[notify] email skipped — no non-interactive email provider configured (SMTP/Resend/SendGrid).')
    return false
  }
  const results = await Promise.allSettled(list.map(addr => sendEmail({ to: [addr], subject, text })))
  // sendEmail THROWS on terminal failure (it never resolves a failure value),
  // so fulfilled === the provider accepted the message. Log each rejection —
  // a silently-lost alert is undiagnosable in prod (review finding, v1.156.1).
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('[notify] email to', list[i], 'failed:', (r.reason as any)?.message || r.reason)
    }
  })
  return results.some(r => r.status === 'fulfilled')
}

/**
 * LINE — deliberate no-op seam (see file header). LINE Notify was shut down
 * Mar 2025, so real delivery needs a Messaging-API bot: set LINE_CHANNEL_TOKEN
 * and the recipient's LINE userId, then push here. Until then this returns false
 * so callers can list it as a channel without any behavior change today.
 */
export async function notifyLine(_text: string, _toUserId?: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_TOKEN?.trim()
  const to = (_toUserId || process.env.LINE_URGENT_USER_ID || '').trim()
  if (!token || !to) return false // not configured — the expected state today
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: _text.slice(0, 4990) }] }),
    })
    if (!res.ok) { console.error(`[notify] line ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`); return false }
    return true
  } catch (err: any) {
    console.error('[notify] line failed:', err?.message || err)
    return false
  }
}
