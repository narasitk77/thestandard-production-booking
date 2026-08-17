// v1.61.0 — camera-capacity check, generalised in v1.177 to cameras + crew.
//
// Loads the OTHER active bookings whose shoot date-range overlaps a candidate,
// then hands them to the pure `resource-load` module for the window math and the
// Thai advisory text. Advisory only — nothing here blocks a booking.
//
// Two things this layer fixed in v1.177:
//  1. ASSIGNED bookings were missing from the status filter. A job that had been
//     assigned crew (the state between REQUESTED and CONFIRMED) contributed zero
//     cameras to the total, so the busiest jobs were the ones being undercounted.
//  2. Crew pools are read from the live TeamMember roster rather than a constant,
//     so hiring or deactivating someone changes the warning without a deploy.
import { prisma } from '@/lib/db'
// v1.118 — single source of truth for the HH:MM window math (client-safe, pure).
import { timeWindowsOverlap } from '@/lib/shoot-window'
import {
  CAMERA_POOL, loadWarningsTh, summariseLoad,
  type LoadDemand, type LoadSummary, type Pools,
} from '@/lib/resource-load'

/** Kept as the old name — the pool of cameras the team owns. */
export const CAMERA_LIMIT = CAMERA_POOL

export interface OverlapCandidate {
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string                 // HH:MM
  estimatedWrap?: string | null     // HH:MM; null → estimated wrap (call + 8h)
  shootType?: string | null         // STUDIO | ON_LOCATION | REMOTE_ONLINE | EVENT
  cameraCount?: number | null
  videographerCount?: number | null
  switcherCount?: number | null
  excludeBookingId?: string         // exclude self when viewing an existing booking
}

export { timeWindowsOverlap }

function asDate(d: Date | string): Date {
  return typeof d === 'string' ? new Date(d) : d
}

/** Same-day? Used to decide whether a row occupies the whole day (see LoadSlot). */
function spansMultipleDays(start: Date, end: Date | null | undefined): boolean {
  if (!end) return false
  return end.getTime() > start.getTime()
}

/**
 * The staffed pools. `role` values come from the TeamMember roster comment:
 * producer | video | director | sound | photo | switcher | virtualProduction.
 * Only the two roles a booking asks for a HEADCOUNT of are pooled here —
 * videographerCount and switcherCount are the fields the wizard collects.
 */
export async function crewPools(): Promise<Pick<Pools, 'videographers' | 'switchers'>> {
  const [videographers, switchers] = await Promise.all([
    prisma.teamMember.count({ where: { role: 'video', active: true } }),
    prisma.teamMember.count({ where: { role: 'switcher', active: true } }),
  ])
  return { videographers, switchers }
}

export interface SlotLoad {
  summary: LoadSummary
  /** Ready-to-render Thai lines; empty when everything fits. */
  warnings: string[]
  pools: Pools
}

/**
 * Compute the full resource load for a candidate slot.
 *
 * Date-range overlap is done in SQL; the time-of-day comparison is done in JS
 * because an HH:MM string comparison cannot be expressed in a Prisma WHERE.
 */
export async function computeSlotLoad(candidate: OverlapCandidate): Promise<SlotLoad> {
  const candStart = asDate(candidate.shootDate)
  const candEndDate = candidate.shootEndDate ? asDate(candidate.shootEndDate) : null
  const candEnd = candEndDate ?? candStart

  const [rows, pools] = await Promise.all([
    prisma.booking.findMany({
      where: {
        // REQUESTED + ASSIGNED + CONFIRMED = every booking still expected to shoot.
        // CANCELLED and COMPLETED release their gear.
        status: { in: ['REQUESTED', 'ASSIGNED', 'CONFIRMED'] },
        deletedAt: null,
        ...(candidate.excludeBookingId ? { id: { not: candidate.excludeBookingId } } : {}),
        shootDate: { lte: candEnd },
        OR: [
          { shootEndDate: null, shootDate: { gte: candStart } },
          { shootEndDate: { gte: candStart } },
        ],
      },
      select: {
        shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
        shootType: true, cameraCount: true, videographerCount: true, switcherCount: true,
        // Without this the headcounts lie — both default to 1 whether or not the
        // role was ever ticked. See LoadDemand.crewRequired.
        crewRequired: true,
      },
    }),
    crewPools(),
  ])

  const others: LoadDemand[] = rows.map(b => ({
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap,
    shootType: b.shootType,
    multiDay: spansMultipleDays(b.shootDate, b.shootEndDate),
    cameraCount: b.cameraCount,
    videographerCount: b.videographerCount,
    switcherCount: b.switcherCount,
    crewRequired: b.crewRequired,
  }))

  const self: LoadDemand = {
    callTime: candidate.callTime,
    estimatedWrap: candidate.estimatedWrap,
    shootType: candidate.shootType,
    multiDay: spansMultipleDays(candStart, candEndDate),
    cameraCount: candidate.cameraCount,
    videographerCount: candidate.videographerCount,
    switcherCount: candidate.switcherCount,
  }

  const allPools: Pools = { cameras: CAMERA_POOL, ...pools }
  const summary = summariseLoad(self, others, allPools)
  return { summary, warnings: loadWarningsTh(summary), pools: allPools }
}
