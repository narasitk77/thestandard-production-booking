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

const LOOKUP_SELECT = {
  id: true,
  bookingCode: true,
  shootDate: true,
  producer: true,
  assignedEmails: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { code: true, name: true } },
} as const

// NOTE (v1.51): these lookups intentionally do NOT filter `deletedAt` — the
// footage sync worker matches Drive files by Production ID, and a file shot
// for a soft-deleted (hidden) booking should still attribute correctly
// instead of degrading to parsed_no_booking. Soft delete hides web surfaces
// only; ID slots and footage attribution stay live.
export async function findBookingByProductionId(code: string): Promise<ProductionIdLookup> {
  if (!code) return null
  const booking = await prisma.booking.findUnique({
    where: { bookingCode: code },
    select: LOOKUP_SELECT,
  })
  return booking
}

/**
 * Batched lookup — single DB roundtrip for N codes. Used by the sync
 * worker so a tick with 1000 newly-detected files doesn't fire 1000
 * sequential Prisma findUniques. Returns a Map keyed by bookingCode.
 *
 * Codes not found in the DB are simply absent from the returned Map —
 * caller does `map.get(code)` and gets `undefined`, treats that as
 * `parsed_no_booking`.
 */
export async function findBookingsByProductionIds(
  codes: string[],
): Promise<Map<string, NonNullable<ProductionIdLookup>>> {
  const uniqueCodes = Array.from(new Set(codes.filter(Boolean)))
  const out = new Map<string, NonNullable<ProductionIdLookup>>()
  if (uniqueCodes.length === 0) return out

  const rows = await prisma.booking.findMany({
    where: { bookingCode: { in: uniqueCodes } },
    select: LOOKUP_SELECT,
  })
  for (const row of rows) {
    if (row.bookingCode) out.set(row.bookingCode, row)
  }
  return out
}
