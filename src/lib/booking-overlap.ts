// v1.61.0 — camera-capacity check. The studio owns 9 cameras; when bookings
// whose shoot date-range AND call-time window overlap request more than 9
// cameras in total, extra cameras must be rented. This lib sums cameraCount
// across OTHER active bookings (REQUESTED + CONFIRMED, not soft-deleted) that
// overlap a candidate. The caller adds the candidate's own cameraCount to
// compare against CAMERA_LIMIT. Advisory only — nothing here blocks a booking.
import { prisma } from '@/lib/db'

export const CAMERA_LIMIT = 9

export interface OverlapCandidate {
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string                 // HH:MM
  estimatedWrap?: string | null     // HH:MM; null = open-ended (treated as 23:59)
  excludeBookingId?: string         // exclude self when viewing an existing booking
}

// Lexicographic HH:MM overlap. Ranges [aS,aE] and [bS,bE] overlap iff
// aS < bE && bS < aE (touching edges like 12:00–12:00 do NOT overlap).
// A missing start time means we can't place the booking → no overlap.
export function timeWindowsOverlap(
  aStart: string,
  aEnd: string | null | undefined,
  bStart: string | null | undefined,
  bEnd: string | null | undefined,
): boolean {
  if (!aStart || !bStart) return false
  const aE = aEnd || '23:59'
  const bE = bEnd || '23:59'
  return aStart < bE && bStart < aE
}

function asDate(d: Date | string): Date {
  return typeof d === 'string' ? new Date(d) : d
}

/**
 * Sum cameraCount of OTHER active bookings (REQUESTED + CONFIRMED, deletedAt
 * null) whose date-range AND time-window overlap the candidate. Does NOT
 * include the candidate's own cameraCount — the caller adds that to compare
 * against CAMERA_LIMIT.
 */
export async function computeOverlapCameraCount(candidate: OverlapCandidate): Promise<number> {
  const candStart = asDate(candidate.shootDate)
  const candEnd = candidate.shootEndDate ? asDate(candidate.shootEndDate) : candStart

  // Date-range overlap in Prisma: existing.shootDate <= candEnd AND
  // existing.end >= candStart, where existing.end = shootEndDate ?? shootDate.
  // Time-window overlap is filtered in JS below (HH:MM string compare can't be
  // expressed in a Prisma WHERE).
  const active = await prisma.booking.findMany({
    where: {
      status: { in: ['REQUESTED', 'CONFIRMED'] },
      deletedAt: null,
      ...(candidate.excludeBookingId ? { id: { not: candidate.excludeBookingId } } : {}),
      shootDate: { lte: candEnd },
      OR: [
        { shootEndDate: null, shootDate: { gte: candStart } },
        { shootEndDate: { gte: candStart } },
      ],
    },
    select: { callTime: true, estimatedWrap: true, cameraCount: true },
  })

  let total = 0
  for (const b of active) {
    if (timeWindowsOverlap(candidate.callTime, candidate.estimatedWrap, b.callTime, b.estimatedWrap)) {
      total += b.cameraCount ?? 0
    }
  }
  return total
}
