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
