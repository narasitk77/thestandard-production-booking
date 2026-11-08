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
    // callTime — isShootOver needs it to see an overnight (wrap ≤ call) shoot
    select: { id: true, bookingCode: true, shootDate: true, shootEndDate: true, estimatedWrap: true, callTime: true },
  })

  const done = confirmed.filter(b => isShootOver(b, now))
  if (done.length === 0) return 0

  // v1.54.1 — the update re-checks status/deletedAt so a booking cancelled
  // or deleted between this read and the write can't be resurrected to
  // COMPLETED (CANCELLED is terminal).
  // Per row (not one updateMany): this runs on every GET /api/bookings, so two
  // concurrent calls see the same candidates — the count and the log line below
  // name only the rows THIS call flipped.
  const flipped: string[] = []
  for (const b of done) {
    const r = await prisma.booking.updateMany({
      where: { id: b.id, status: 'CONFIRMED', deletedAt: null },
      data: { status: 'COMPLETED' },
    })
    if (r.count > 0) flipped.push(b.bookingCode || b.id)
  }
  // The Bookings sheet is NOT written here: its Status column keeps CONFIRMED for
  // finished shoots, as in prod. PMDC's Airtable sync reads that column and nobody
  // has confirmed it accepts COMPLETED — sending it is a decision pending with Nat.
  if (flipped.length > 0) console.log(`[auto-complete] CONFIRMED → COMPLETED: ${flipped.join(', ')}`)
  return flipped.length
}
