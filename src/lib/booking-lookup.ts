/**
 * Look up a Booking row by its human-readable Production ID
 * (`Booking.bookingCode` — the `@unique` index covers this).
 *
 * Used by the footage-sheet sync worker to fill in booking-derived fields
 * (outlet, program, shoot date, assigned crew) when writing a sheet row
 * for a newly-detected Drive file.
 *
 * Returns null when no booking has that code — the worker still records
 * the file in `FootageLog` with `parseStatus = 'parsed_no_booking'` so
 * we can surface "filename had a valid format but no booking matched"
 * in diagnostics.
 */

import { prisma } from './db'

export type ProductionIdLookup = {
  id: string
  bookingCode: string | null
  shootDate: Date
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  producer: string | null
  assignedEmails: string[]
} | null

export async function findBookingByProductionId(code: string): Promise<ProductionIdLookup> {
  if (!code) return null
  const booking = await prisma.booking.findUnique({
    where: { bookingCode: code },
    select: {
      id: true,
      bookingCode: true,
      shootDate: true,
      producer: true,
      assignedEmails: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { code: true, name: true } },
    },
  })
  return booking
}
