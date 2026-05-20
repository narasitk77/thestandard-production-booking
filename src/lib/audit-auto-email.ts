/**
 * Auto-email purge warning to admins.
 *
 * Fired in fire-and-forget mode from the purge-warning endpoint whenever any
 * admin loads the dashboard. The throttle (canSendAutoEmail) ensures one
 * email per 24 h regardless of how many admins click around.
 *
 * The email contains a link to /api/audit/export so admins can grab a CSV
 * without re-opening the dashboard.
 */
import { prisma } from './db'
import { sendEmail, isEmailConfigured } from './email'
import {
  getPurgeWarning,
  canSendAutoEmail,
  RETENTION_DAYS,
  WARNING_DAYS,
} from './audit-retention'
import { logAudit } from './audit'

type AutoEmailResult =
  | { sent: true; recipientCount: number }
  | { sent: false; reason: 'no_warning' | 'throttled' | 'no_admins' | 'not_configured' | 'error' }

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '—'
}

export async function tryAutoEmailPurgeWarning(): Promise<AutoEmailResult> {
  try {
    const warning = await getPurgeWarning()
    if (!warning.shouldWarn) return { sent: false, reason: 'no_warning' }
    if (!(await canSendAutoEmail())) return { sent: false, reason: 'throttled' }
    if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' }

    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', active: true },
      select: { email: true },
    })
    if (admins.length === 0) return { sent: false, reason: 'no_admins' }

    const appUrl =
      process.env.NEXTAUTH_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'https://production-booking-app.onrender.com'
    const fromParam = warning.oldestAt
      ? `?from=${encodeURIComponent(warning.oldestAt.toISOString())}`
      : ''
    const csvUrl = `${appUrl}/api/audit/export${fromParam}`
    const purgeDate = isoDate(warning.nextPurgeBefore)
    const oldestDate = isoDate(warning.oldestAt)

    const text = `แจ้งเตือน: Audit log ใกล้ครบ ${RETENTION_DAYS} วัน

มี audit log ${warning.countInWindow} รายการที่จะถูกลบในวันที่ ${purgeDate}
(เก่าสุด: ${oldestDate})

คุณยังมีเวลาประมาณ ${WARNING_DAYS} วันก่อนข้อมูลถูกลบจริง

ดาวน์โหลด CSV ก่อนข้อมูลถูกลบ:
${csvUrl}

(อีเมลนี้ส่งให้ admin ทุกคนของระบบ; ดาวน์โหลดครั้งเดียวก็พอ)

THE STANDARD Production Booking`

    await sendEmail({
      to: admins.map(a => a.email),
      subject: `[Audit] ${warning.countInWindow} log records will be purged on ${purgeDate}`,
      text,
    })

    // Eat our own dog food: log the email itself in the audit trail so
    // canSendAutoEmail() can find it for the throttle check next time.
    await logAudit({
      action: 'audit.auto_email_sent',
      entityType: 'AuditLog',
      changes: {
        recipientCount: admins.length,
        warningCount: warning.countInWindow,
        purgeDate,
        oldestDate,
      },
    })

    return { sent: true, recipientCount: admins.length }
  } catch (err: any) {
    console.error('[audit-auto-email] failed:', err?.message || err)
    return { sent: false, reason: 'error' }
  }
}
