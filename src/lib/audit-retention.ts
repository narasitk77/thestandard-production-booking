/**
 * Audit log retention policy.
 *
 *   Window:           90 days
 *   Pre-purge warning: 14 days before any row would be purged
 *   Auto-email throttle: at most once every 24 hours
 *
 * The "warning window" is the range of rows whose `at` is older than
 * (RETENTION_DAYS - WARNING_DAYS) days but younger than RETENTION_DAYS days.
 * As long as that set is non-empty, the admin banner asks for a CSV download
 * and a daily auto-email is queued.
 */
import { prisma } from './db'

export const RETENTION_DAYS = 90
export const WARNING_DAYS = 14
export const AUTO_EMAIL_THROTTLE_HOURS = 24

export type PurgeWarning = {
  shouldWarn: boolean
  countInWindow: number
  oldestAt: Date | null
  // The earliest `at` in the warning window will be deleted on/after this date
  nextPurgeBefore: Date | null
  retentionDays: number
  warningDays: number
}

function daysAgo(days: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

/**
 * Inspect audit_logs and return the current warning state. Cheap — uses the
 * `at` index. Returns `shouldWarn=false` when nothing is in the danger zone.
 */
export async function getPurgeWarning(): Promise<PurgeWarning> {
  const warningCutoff = daysAgo(RETENTION_DAYS - WARNING_DAYS) // older than this = in window
  const retentionCutoff = daysAgo(RETENTION_DAYS)              // older than this = already overdue
  const inWindow = await prisma.auditLog.findMany({
    where: { at: { lt: warningCutoff, gte: retentionCutoff } },
    orderBy: { at: 'asc' },
    take: 1,
    select: { at: true },
  })
  const count = await prisma.auditLog.count({
    where: { at: { lt: warningCutoff, gte: retentionCutoff } },
  })

  const oldestAt = inWindow[0]?.at ?? null
  // Row deleted when (now - at) >= RETENTION_DAYS  ⇔  at <= now - RETENTION_DAYS
  const nextPurgeBefore = oldestAt
    ? new Date(oldestAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
    : null

  return {
    shouldWarn: count > 0,
    countInWindow: count,
    oldestAt,
    nextPurgeBefore,
    retentionDays: RETENTION_DAYS,
    warningDays: WARNING_DAYS,
  }
}

/**
 * Whether enough time has passed since the last auto-email to send another.
 * Reads its own audit trail to find the previous send. Returns true when
 * nothing has been sent yet, or when the last send is older than the throttle.
 */
export async function canSendAutoEmail(): Promise<boolean> {
  const last = await prisma.auditLog.findFirst({
    where: { action: 'audit.auto_email_sent' },
    orderBy: { at: 'desc' },
    select: { at: true },
  })
  if (!last) return true
  const elapsedHours = (Date.now() - last.at.getTime()) / (1000 * 60 * 60)
  return elapsedHours >= AUTO_EMAIL_THROTTLE_HOURS
}

/**
 * Async generator over the export query. Pages 500 rows at a time so memory
 * footprint stays flat regardless of total row count.
 */
export async function* iterateAuditLogs(args: {
  from?: Date
  to?: Date
  action?: string
  entityId?: string
  pageSize?: number
}): AsyncGenerator<{
  at: Date
  actorEmail: string | null
  action: string
  entityType: string
  entityId: string | null
  bookingCode: string | null
  fromStatus: string | null
  toStatus: string | null
  changes: unknown
}> {
  const pageSize = args.pageSize ?? 500
  let cursor: string | undefined
  while (true) {
    const where: any = {}
    if (args.from || args.to) {
      where.at = {}
      if (args.from) where.at.gte = args.from
      if (args.to) where.at.lte = args.to
    }
    if (args.action) where.action = args.action
    if (args.entityId) where.entityId = args.entityId

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { at: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        at: true,
        actorEmail: true,
        action: true,
        entityType: true,
        entityId: true,
        bookingCode: true,
        fromStatus: true,
        toStatus: true,
        changes: true,
      },
    })
    if (rows.length === 0) break
    for (const r of rows) yield r
    if (rows.length < pageSize) break
    cursor = rows[rows.length - 1].id
  }
}
