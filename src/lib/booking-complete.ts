import { prisma } from './db'

/**
 * Auto-complete CONFIRMED bookings whose shoot has ended.
 *
 * Multi-day support: uses shootEndDate when set, otherwise shootDate.
 *
 * Rules (Bangkok time UTC+7):
 *  1. Last shoot day is before today → completed (day-after auto-close)
 *  2. Last shoot day is today AND estimatedWrap time has passed → completed same-day
 *  3. Last shoot day is today AND no estimatedWrap → completed after 23:00
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

  // Fetch all CONFIRMED bookings — we'll classify them in JS so we can
  // use shootEndDate when present, shootDate otherwise
  const confirmed = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', deletedAt: null },
    select: { id: true, shootDate: true, shootEndDate: true, estimatedWrap: true },
  })

  // v1.54.1 — the updateMany writes below re-check status/deletedAt so a
  // booking cancelled or deleted between this read and the write can't be
  // resurrected to COMPLETED (CANCELLED is terminal).
  const pastIds: string[] = []
  const todayIds: string[] = []

  for (const b of confirmed) {
    // "Last day" of the shoot: shootEndDate if set, otherwise shootDate
    const lastDay = b.shootEndDate ?? b.shootDate

    if (lastDay < todayBkk) {
      // Case 1: last shoot day has fully passed
      pastIds.push(b.id)
    } else if (lastDay.getTime() === todayBkk.getTime()) {
      // Case 2 & 3: last shoot day is today
      todayIds.push(b.id)
    }
    // Future bookings: leave as CONFIRMED
  }

  if (pastIds.length > 0) {
    const r = await prisma.booking.updateMany({
      where: { id: { in: pastIds }, status: 'CONFIRMED', deletedAt: null },
      data: { status: 'COMPLETED' },
    })
    completed += r.count
  }

  if (todayIds.length > 0) {
    // Re-fetch today's bookings with wrap times
    const todayBookings = confirmed.filter(b => todayIds.includes(b.id))
    const doneToday = todayBookings
      .filter(b => {
        if (b.estimatedWrap) return bkkTimeStr >= b.estimatedWrap
        return bkkTimeStr >= '23:00'
      })
      .map(b => b.id)

    if (doneToday.length > 0) {
      const r = await prisma.booking.updateMany({
        where: { id: { in: doneToday }, status: 'CONFIRMED', deletedAt: null },
        data: { status: 'COMPLETED' },
      })
      completed += r.count
    }
  }

  return completed
}
