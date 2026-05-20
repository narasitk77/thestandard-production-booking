/**
 * Booking status transition whitelist.
 *
 * Each entry lists which target statuses are reachable from the key. Anything
 * not in the list is rejected with HTTP 400 — guards against UI bugs that
 * could let users skip states (e.g. COMPLETED → REQUESTED).
 */
import type { BookingStatus } from '@prisma/client'

const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  REQUESTED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['CONFIRMED', 'CANCELLED', 'REQUESTED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
  CANCELLED: [],
  COMPLETED: ['CONFIRMED'], // admin re-open path only
}

export function isStatusTransitionAllowed(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  if (from === to) return true
  return ALLOWED[from]?.includes(to) ?? false
}

export function assertStatusTransition(
  from: BookingStatus,
  to: BookingStatus,
): void {
  if (!isStatusTransitionAllowed(from, to)) {
    throw Object.assign(
      new Error(`Invalid status transition: ${from} → ${to}`),
      { statusCode: 400, code: 'INVALID_TRANSITION' },
    )
  }
}
