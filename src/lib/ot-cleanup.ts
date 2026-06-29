import { prisma } from './db'
import { todayBangkokStr } from './bangkok-day'

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
  // Bangkok-local date — the server runs UTC, so deriving "now" from new Date()
  // drifts a day (and the month) for the ~7h each morning that is still yesterday
  // in UTC. Use the same business-timezone source as the editable-month gate.
  const [year, month, day] = todayBangkokStr().split('-').map(Number)
  const currentMonth = `${year}-${String(month).padStart(2, '0')}` // e.g. "2026-04"

  const prevDate = new Date(Date.UTC(year, month - 2, 1)) // month is 1-based; -2 = previous month index
  const prevMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`

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
  // Bangkok month, not server-UTC month — otherwise OT entry/edit for "today" is
  // wrongly rejected as a closed month during the early-morning UTC/Bangkok gap.
  return todayBangkokStr().slice(0, 7)
}

export function isMonthEditable(month: string): boolean {
  return month === currentMonthYYYYMM()
}
