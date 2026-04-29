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

  // 1) Drop records outside the keep window (10-day archive policy)
  const oldDel = await prisma.oTRecord.deleteMany({
    where: { month: { notIn: keep } },
  })

  // 2) Drop legacy pre-v1.15 records that lack the new task fields.
  //    Safe filter: missing both startTime AND justification (so we never delete
  //    a freshly-created record that just hasn't been opened yet).
  const legacyDel = await prisma.oTRecord.deleteMany({
    where: {
      AND: [
        { startTime: null },
        { justification: null },
      ],
    },
  })

  return oldDel.count + legacyDel.count
}

export function currentMonthYYYYMM(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function isMonthEditable(month: string): boolean {
  return month === currentMonthYYYYMM()
}
