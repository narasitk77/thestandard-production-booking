import { prisma } from './db'
import { parseTimeToMinutes } from './ot-calc'

/**
 * Auto-generate OT TASK records from a booking's assigned crew.
 *
 * Each assigned crew gets one record per booking with:
 *  - startTime = booking.callTime
 *  - endTime = booking.estimatedWrap (or callTime + 4h default)
 *  - jobTask = "[Auto] OUTLET·PROGRAM EpisodeIDs"
 *  - justification = "Auto from booking ID"
 *
 * Day-type / OT amount is computed at view time from the date + tasks list.
 *
 * Idempotent: deletes any existing records linked to this booking first.
 */
export async function syncBookingOT(bookingId: string): Promise<{ created: number }> {
  await prisma.oTRecord.deleteMany({ where: { bookingId } })

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { outlet: true, program: true, episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } } },
  })
  if (!booking) return { created: 0 }
  if (booking.status === 'CANCELLED') return { created: 0 }

  const emails = (booking.assignedEmails || []).filter(Boolean)
  if (emails.length === 0) return { created: 0 }
  if (!booking.callTime) return { created: 0 }

  const startTime = booking.callTime
  const endTime = booking.estimatedWrap || addHoursStr(startTime, 4)
  const date = new Date(booking.shootDate)
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

  // v1.42.0 — overnight shoots: when the wrap time is at/before the call time
  // the shift ran past midnight, so the OT record ends the NEXT day. Otherwise
  // endDate stays null (same-day). parseTimeToMinutes guards bad formats.
  const sMin = parseTimeToMinutes(startTime)
  const eMin = parseTimeToMinutes(endTime)
  const overnight = sMin !== null && eMin !== null && eMin <= sMin
  const endDate = overnight ? new Date(date.getTime() + 86_400_000) : null

  const epIds = booking.episodes.map(e => e.episodeId).join(', ')
  const jobTask = `[Auto] ${booking.outlet.code}·${booking.program.code}${epIds ? ` (${epIds})` : ''}`
  const justification = `Auto-generated from approved booking ${booking.id}`

  await prisma.oTRecord.createMany({
    data: emails.map(email => ({
      userEmail: email.toLowerCase(),
      month,
      date,
      endDate,
      startTime,
      endTime,
      jobTask,
      justification,
      bookingId,
    })),
  })

  return { created: emails.length }
}

export async function clearBookingOT(bookingId: string): Promise<number> {
  const result = await prisma.oTRecord.deleteMany({ where: { bookingId } })
  return result.count
}

function addHoursStr(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + hours * 60
  const eh = Math.min(23, Math.floor(total / 60))
  const em = total % 60
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
}
