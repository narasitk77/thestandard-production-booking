// v1.156 — "แจ้งเตือนเมื่อมีงานด่วนเข้ามา": when a booking is created for a shoot
// that is only a day or two away, ping the people who have to scramble for it.
//
// Channels (ops decision 2026-07-28): email → the Production Coordinator (Tui).
// Explicitly NOT Discord — that channel stays footage-only. A LINE arm is wired
// but stays a no-op until a Messaging-API bot is configured (see notify.ts
// notifyLine).
//
// Fires once per booking (atomic urgentAlertedAt claim) and skips routine
// bulk-generated bookings, which are created far ahead and would otherwise be
// scored as non-urgent anyway — the guard just makes that explicit and cheap.

import { prisma } from './db'
import { notifyEmail, notifyLine } from './notify'
import { isEmailConfigured } from './email'

/** BKK calendar-day index (days since epoch in Asia/Bangkok, tz-fixed +07:00). */
function bkkDayIndex(d: Date): number {
  const bkk = new Date(d.getTime() + 7 * 3_600_000)
  return Math.floor(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) / 86_400_000)
}

/**
 * Calendar days from the booking day to the shoot day, in Bangkok time. 0 = the
 * shoot is on the day it was booked; 2 = booked two days ahead; negative = the
 * shoot day is already past. shootDate is @db.Date (midnight UTC), so comparing
 * day INDEXES (not raw ms) is what avoids the off-by-one across the tz offset.
 */
export function urgentLeadDays(shootDate: Date, bookedAt: Date): number {
  return bkkDayIndex(shootDate) - bkkDayIndex(bookedAt)
}

/** Urgent = the shoot is today or up to `maxLeadDays` out (default 2). A shoot
 *  already in the past (negative lead, e.g. a back-filled booking) is NOT urgent. */
export function isUrgentLead(shootDate: Date, bookedAt: Date, maxLeadDays: number): boolean {
  const lead = urgentLeadDays(shootDate, bookedAt)
  return lead >= 0 && lead <= maxLeadDays
}

/** Env-tunable lead threshold; user asked for "booked same day or 1-2 days before". */
export function urgentLeadThreshold(): number {
  const n = parseInt(process.env.URGENT_LEAD_DAYS || '', 10)
  return Number.isFinite(n) && n >= 0 ? n : 2
}

/** Who the urgent email goes to — the coordinator (Tui). Reuses the same env the
 *  cancel-request notifier uses, with a dedicated override and a safe default. */
function urgentEmailRecipients(): string[] {
  const raw = process.env.URGENT_NOTIFY_EMAIL || process.env.CANCEL_NOTIFY_EMAIL || 'tossapol.b@thestandard.co'
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export interface UrgentBookingInput {
  id: string
  bookingCode: string | null
  shootDate: Date
  callTime: string | null
  createdAt: Date
  isRoutine: boolean
  urgentAlertedAt: Date | null
  producer: string | null
  outlet: { code: string; name: string }
  program: { name: string }
  virtualProduction?: boolean
}

export interface UrgentAlertResult {
  alerted: boolean
  reason?: 'routine' | 'not-urgent' | 'already-alerted' | 'claim-lost' | 'no-channel' | 'delivery-failed'
  leadDays?: number
}

/** True when at least one delivery channel is actually configured. Checked
 *  BEFORE the send-once claim so an unconfigured env can't burn the claim on a
 *  no-op (review finding, v1.156.1). */
function anyChannelConfigured(): boolean {
  if (isEmailConfigured()) return true
  return !!(process.env.LINE_CHANNEL_TOKEN?.trim() && process.env.LINE_URGENT_USER_ID?.trim())
}

function buildMessage(b: UrgentBookingInput, leadDays: number): { subject: string; text: string } {
  const code = b.bookingCode || b.id
  const date = new Date(b.shootDate).toISOString().slice(0, 10)
  const when = leadDays === 0 ? 'วันนี้' : leadDays === 1 ? 'พรุ่งนี้' : `อีก ${leadDays} วัน`
  const link = process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL.replace(/\/$/, '')}/admin?booking=${b.id}` : ''
  const subject = `⚡ งานด่วน — ${code} ถ่าย${when} (${date})`
  const text =
    `⚡ มีงานด่วนเข้ามา — ถ่าย${when}\n\n` +
    `งาน: ${code} · ${b.outlet.name} · ${b.program.name}\n` +
    `วันถ่าย: ${date} ${b.callTime || ''}`.trim() + `\n` +
    `Producer: ${b.producer || '—'}\n` +
    (b.virtualProduction ? `Virtual Production: ใช่ (assign Assawapol แล้ว)\n` : '') +
    `จองล่วงหน้า: ${leadDays} วัน\n` +
    (link ? `\nเปิดดู: ${link}` : '')
  return { subject, text }
}

/**
 * Dispatch the urgent alert for a freshly-created booking, exactly once.
 * Best-effort and self-contained: never throws (safe to fire-and-forget from the
 * create path). Returns what it decided, for logging/tests.
 */
export async function maybeAlertUrgentBooking(b: UrgentBookingInput): Promise<UrgentAlertResult> {
  try {
    if (b.isRoutine) return { alerted: false, reason: 'routine' }
    if (b.urgentAlertedAt) return { alerted: false, reason: 'already-alerted' }

    const leadDays = urgentLeadDays(b.shootDate, b.createdAt)
    if (!isUrgentLead(b.shootDate, b.createdAt, urgentLeadThreshold())) {
      return { alerted: false, reason: 'not-urgent', leadDays }
    }

    // No channel configured → don't claim (the claim would be burned on a
    // no-op and the alert lost forever once email IS configured).
    if (!anyChannelConfigured()) {
      console.warn('[urgent-booking] no delivery channel configured — alert skipped:', b.bookingCode || b.id)
      return { alerted: false, reason: 'no-channel', leadDays }
    }

    // Atomic claim: only the caller that flips urgentAlertedAt from null wins, so
    // the alert can't double-send if the create path is ever retried/duplicated.
    const claim = await prisma.booking.updateMany({
      where: { id: b.id, urgentAlertedAt: null },
      data: { urgentAlertedAt: new Date() },
    })
    if (claim.count === 0) return { alerted: false, reason: 'claim-lost', leadDays }

    const { subject, text } = buildMessage(b, leadDays)
    // Both arms are best-effort no-throw; LINE is a no-op until configured.
    // No Discord on purpose — that channel is footage-only (see file header).
    const [emailRes, lineRes] = await Promise.allSettled([
      notifyEmail(urgentEmailRecipients(), subject, text),
      notifyLine(text),
    ])
    const delivered =
      (emailRes.status === 'fulfilled' && emailRes.value === true) ||
      (lineRes.status === 'fulfilled' && lineRes.value === true)
    if (!delivered) {
      // Nothing reached anyone — release the claim so the alert isn't silently
      // lost behind a stamped urgentAlertedAt (review finding, v1.156.1).
      await prisma.booking.updateMany({ where: { id: b.id }, data: { urgentAlertedAt: null } }).catch(() => {})
      console.error('[urgent-booking] delivery failed on every channel — claim released:', b.bookingCode || b.id)
      return { alerted: false, reason: 'delivery-failed', leadDays }
    }
    return { alerted: true, leadDays }
  } catch (e: any) {
    console.error('[urgent-booking] alert failed (non-fatal):', b.bookingCode || b.id, e?.message || e)
    return { alerted: false }
  }
}
