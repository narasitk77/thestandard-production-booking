// v1.61.0 — camera-capacity check. The studio owns 9 cameras; when bookings
// whose shoot date-range AND call-time window overlap request more than 9
// cameras in total, extra cameras must be rented. This lib sums cameraCount
// across OTHER active bookings (REQUESTED + CONFIRMED, not soft-deleted) that
// overlap a candidate. The caller adds the candidate's own cameraCount to
// compare against CAMERA_LIMIT. Advisory only — nothing here blocks a booking.
import { prisma } from '@/lib/db'
// v1.118 — single source of truth for the HH:MM window math (client-safe, pure).
import { timeWindowsOverlap, effectiveWrap } from '@/lib/shoot-window'

export const CAMERA_LIMIT = 9

export interface OverlapCandidate {
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string                 // HH:MM
  estimatedWrap?: string | null     // HH:MM; null → estimated wrap (call + 8h)
  excludeBookingId?: string         // exclude self when viewing an existing booking
}

export { timeWindowsOverlap }

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

  // v1.118 — compare EFFECTIVE windows (a missing wrap = call + 8h, not 23:59),
  // so a shoot with no wrap time no longer "holds" the whole day and clashes
  // with everything.
  const candEndT = effectiveWrap(candidate.callTime, candidate.estimatedWrap).end
  let total = 0
  for (const b of active) {
    const bEndT = effectiveWrap(b.callTime, b.estimatedWrap).end
    if (timeWindowsOverlap(candidate.callTime, candEndT, b.callTime, bEndT)) {
      total += b.cameraCount ?? 0
    }
  }
  return total
}
