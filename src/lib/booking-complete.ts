import { prisma } from './db'
import { isShootOver } from './shoot-window'

// Re-exported so existing importers (`@/lib/booking-complete`) keep working;
// the logic itself lives in the pure, DB-free ./shoot-window module.
export { isShootOver } from './shoot-window'
export type { ShootWindow } from './shoot-window'

/**
 * Auto-complete CONFIRMED bookings whose shoot has ended (see isShootOver).
 *
 * Called lazily on each GET /api/bookings — no cron needed.
 */
export async function autoCompleteBookings(): Promise<number> {
  const now = new Date()

  // Fetch all CONFIRMED bookings — classify in JS so we can use shootEndDate
  // when present, shootDate otherwise.
  const confirmed = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', deletedAt: null },
    select: { id: true, shootDate: true, shootEndDate: true, estimatedWrap: true },
  })

  const doneIds = confirmed.filter(b => isShootOver(b, now)).map(b => b.id)
  if (doneIds.length === 0) return 0

  // v1.54.1 — the updateMany re-checks status/deletedAt so a booking cancelled
  // or deleted between this read and the write can't be resurrected to
  // COMPLETED (CANCELLED is terminal).
  const r = await prisma.booking.updateMany({
    where: { id: { in: doneIds }, status: 'CONFIRMED', deletedAt: null },
    data: { status: 'COMPLETED' },
  })
  return r.count
}
