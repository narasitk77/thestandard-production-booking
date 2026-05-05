import { prisma } from './db'

/**
 * Auto-complete CONFIRMED bookings whose shoot has ended.
 *
 * Rules (Bangkok time UTC+7):
 *  1. Shoot date is before today → completed (day-after auto-close)
 *  2. Shoot date is today AND estimatedWrap time has passed → completed same-day
 *  3. Shoot date is today AND no estimatedWrap → completed after 23:00
 *
 * Called lazily on each GET /api/bookings — no cron needed.
 */
export async function autoCompleteBookings(): Promise<number> {
  const now = new Date()

  // Bangkok time = UTC+7
  const bangkokMs = now.getTime() + 7 * 60 * 60 * 1000
  const bkk = new Date(bangkokMs)

  // Today at midnight (UTC representation of Bangkok date)
  const todayBkk = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))

  // Current Bangkok HH:MM string for wrap-time comparison
  const bkkTimeStr =
    String(bkk.getUTCHours()).padStart(2, '0') + ':' + String(bkk.getUTCMinutes()).padStart(2, '0')

  let completed = 0

  // ── Case 1: shoot date is strictly before today ──────────────────────────
  const pastResult = await prisma.booking.updateMany({
    where: {
      status: 'CONFIRMED',
      shootDate: { lt: todayBkk },
    },
    data: { status: 'COMPLETED' },
  })
  completed += pastResult.count

  // ── Case 2 & 3: shoot is today, check wrap time ───────────────────────────
  const todayConfirmed = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      shootDate: todayBkk,
    },
    select: { id: true, estimatedWrap: true },
  })

  const doneToday = todayConfirmed
    .filter(b => {
      if (b.estimatedWrap) {
        // Complete when current Bangkok time is past the wrap time
        return bkkTimeStr >= b.estimatedWrap
      }
      // No wrap time → complete after 23:00
      return bkkTimeStr >= '23:00'
    })
    .map(b => b.id)

  if (doneToday.length > 0) {
    const r = await prisma.booking.updateMany({
      where: { id: { in: doneToday } },
      data: { status: 'COMPLETED' },
    })
    completed += r.count
  }

  return completed
}
