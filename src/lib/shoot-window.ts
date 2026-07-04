/**
 * Pure shoot-window logic — no DB, no side effects, so it's trivially testable
 * and safe to import from both the API routes and the lazy auto-completer.
 *
 * Single source of truth for "the shoot is over", which is the gate for moving
 * a booking to COMPLETED (auto OR manual). Keeping one definition stops the
 * manual "Mark Complete" / "Mark as Done" paths from drifting away from the
 * auto-completer and closing a booking before it's been shot.
 */

/** The shoot-window fields needed to decide whether a shoot has ended. */
export interface ShootWindow {
  shootDate: Date
  shootEndDate: Date | null
  estimatedWrap: string | null
}

/**
 * Has the booking's shoot window ended (Bangkok time, UTC+7)?
 *
 * Multi-day support: uses shootEndDate when set, otherwise shootDate.
 *
 * Rules (Bangkok time UTC+7):
 *  1. Last shoot day is before today → over (day-after close)
 *  2. Last shoot day is today AND estimatedWrap time has passed → over same-day
 *  3. Last shoot day is today AND no estimatedWrap → over after 23:00
 *  4. Last shoot day is in the future → NOT over
 */
export function isShootOver(b: ShootWindow, now: Date = new Date()): boolean {
  // Bangkok = UTC+7 (no DST, so the fixed offset matches Asia/Bangkok)
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  // Today at midnight, as the UTC-midnight Date Prisma stores @db.Date as
  const todayBkk = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))

  // "Last day" of the shoot: shootEndDate if set, otherwise shootDate
  const lastDay = b.shootEndDate ?? b.shootDate

  if (lastDay < todayBkk) return true // Case 1: last shoot day has fully passed
  if (lastDay.getTime() !== todayBkk.getTime()) return false // Case 4: future

  // Cases 2 & 3: last shoot day is today — wrap time (or 23:00 fallback) must have passed
  const bkkTimeStr =
    String(bkk.getUTCHours()).padStart(2, '0') + ':' + String(bkk.getUTCMinutes()).padStart(2, '0')
  return b.estimatedWrap ? bkkTimeStr >= b.estimatedWrap : bkkTimeStr >= '23:00'
}

// ── v1.118 — same-day HH:MM occupancy helpers (Week Plan + camera overlap) ──

/** Add minutes to an "HH:MM", clamped to the same day (max "23:59"). */
export function addMinutesClamped(hhmm: string, mins: number): string {
  const [h, m] = (hhmm || '').split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const total = Math.min(23 * 60 + 59, h * 60 + m + mins)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Typical shoot length when nobody entered a wrap time (hours). */
export const DEFAULT_SHOOT_HOURS = 8

/**
 * The effective wrap ("เวลาเลิกกอง") for occupancy math:
 *   - the entered estimatedWrap when present (accurate);
 *   - else callTime + DEFAULT_SHOOT_HOURS clamped to 23:59 (an estimate).
 * Returns { end, estimated } so the UI can mark the estimated ones with "~".
 * (The OLD camera-overlap treated a missing wrap as 23:59 → the shoot "held"
 * the whole day and falsely clashed with every other shoot.)
 */
export function effectiveWrap(callTime: string, estimatedWrap?: string | null): { end: string; estimated: boolean } {
  const w = (estimatedWrap || '').trim()
  if (w) return { end: w, estimated: false }
  return { end: addMinutesClamped(callTime, DEFAULT_SHOOT_HOURS * 60), estimated: true }
}

/**
 * Do two HH:MM ranges overlap? [aS,aE) vs [bS,bE) — touching edges (12:00–12:00)
 * do NOT overlap. A missing start means the shoot can't be placed → no overlap.
 */
export function timeWindowsOverlap(
  aStart: string,
  aEnd: string | null | undefined,
  bStart: string | null | undefined,
  bEnd: string | null | undefined,
): boolean {
  if (!aStart || !bStart) return false
  const aE = aEnd || '23:59'
  const bE = bEnd || '23:59'
  return aStart < bE && bStart < aE
}
