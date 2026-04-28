import { prisma } from './db'

/**
 * Cleanup OT records based on the 10-day archive policy:
 *
 * - Current month: editable
 * - Previous month: archive (read-only) — kept for 10 days into new month
 * - Older than that: deleted
 *
 * Runs lazily on each /api/ot fetch — no cron needed.
 */
export async function cleanupOTRecords(): Promise<number> {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const currentMonth = `${year}-${month}` // e.g. "2026-04"

  const prevDate = new Date(year, now.getMonth() - 1, 1)
  const prevYear = prevDate.getFullYear()
  const prevMon = String(prevDate.getMonth() + 1).padStart(2, '0')
  const prevMonth = `${prevYear}-${prevMon}`

  const day = now.getDate()

  // Within 10-day grace: keep current + previous
  // After day 10: keep only current
  const keep = day <= 10 ? [currentMonth, prevMonth] : [currentMonth]

  const result = await prisma.oTRecord.deleteMany({
    where: { month: { notIn: keep } },
  })

  return result.count
}

export function currentMonthYYYYMM(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function isMonthEditable(month: string): boolean {
  return month === currentMonthYYYYMM()
}
