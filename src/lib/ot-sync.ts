import { prisma } from './db'
import type { Booking } from '@prisma/client'

/**
 * Auto-generate OT records from a booking's assigned crew.
 *
 * Rules:
 *  - Weekend (Sat/Sun) → HOLIDAY (1 day per crew member)
 *  - Weekday with (estimatedWrap - callTime) > 8 hours → OVERTIME with the excess hours
 *  - Otherwise → no OT record (normal work day)
 *
 * Idempotent: deletes any existing records for this booking first, then re-creates.
 *
 * Records keep `bookingId` so they survive alongside manual entries.
 */
export async function syncBookingOT(bookingId: string): Promise<{ created: number }> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } })
  if (!booking) return { created: 0 }

  // Always remove existing auto-records for this booking first
  await prisma.oTRecord.deleteMany({ where: { bookingId } })

  // Don't generate for cancelled bookings
  if (booking.status === 'CANCELLED') return { created: 0 }

  const emails = (booking.assignedEmails || []).filter(Boolean)
  if (emails.length === 0) return { created: 0 }

  const date = new Date(booking.shootDate)
  const day = date.getDay() // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`

  let type: 'HOLIDAY' | 'OVERTIME' | null = null
  let hours = 0

  if (isWeekend) {
    type = 'HOLIDAY'
  } else {
    const start = parseTimeToMinutes(booking.callTime)
    const end = parseTimeToMinutes(booking.estimatedWrap)
    if (start != null && end != null && end > start) {
      const totalMinutes = end - start
      const totalHours = totalMinutes / 60
      if (totalHours > 8) {
        type = 'OVERTIME'
        hours = Math.round((totalHours - 8) * 100) / 100
      }
    }
  }

  if (!type) return { created: 0 }

  const description = `[Auto] Booking · ${booking.outletId.slice(0, 0)}` // will be improved below

  // Build a richer description with episode IDs
  const fullBooking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { outlet: true, program: true, episodes: { orderBy: { sequence: 'asc' } } },
  })
  const epIds = fullBooking?.episodes.map(e => e.episodeId).join(', ') || ''
  const desc = fullBooking
    ? `[Auto] ${fullBooking.outlet.code}·${fullBooking.program.code} ${epIds}`.trim()
    : '[Auto] from booking'

  await prisma.oTRecord.createMany({
    data: emails.map(email => ({
      userEmail: email.toLowerCase(),
      month,
      date,
      type: type!,
      hours: type === 'OVERTIME' ? hours : 0,
      description: desc,
      bookingId,
    })),
  })

  return { created: emails.length }
}

/**
 * Delete all auto-generated OT records linked to a booking.
 * Called when a booking is cancelled.
 */
export async function clearBookingOT(bookingId: string): Promise<number> {
  const result = await prisma.oTRecord.deleteMany({ where: { bookingId } })
  return result.count
}

function parseTimeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  return parseInt(m[1]) * 60 + parseInt(m[2])
}
