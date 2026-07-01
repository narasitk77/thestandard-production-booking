/**
 * Pure ID-migration logic (v1.109) — no DB / Google side effects, so it's unit
 * testable in isolation. The orchestrator in `regenerate-booking-id.ts` calls
 * `regenerateBookingId` per booking using the plan this module computes.
 *
 * The v1.109 change drops the legacy [TYPE] segment (Episode Type L/S/A/T or
 * Shoot Type STD/LOC/EVT) from every Production/Episode ID. Two old IDs that
 * differ ONLY in that segment (e.g. NWS-260701-L-01 vs NWS-260701-S-01) would
 * collapse to the same code — `Booking.bookingCode` is @unique, so those are
 * detected and LEFT untouched (the "colliding pairs").
 */
import { parseEpisodeId } from './episode-id'

export type EpisodeIdChange = { episodeDbId: string; oldEpisodeId: string; newEpisodeId: string }

/**
 * Drop ONLY the legacy [TYPE] segment from a Production/Episode ID, keeping the
 * outlet, program, date and sequence exactly. Returns null when the id doesn't
 * parse OR carries no type (nothing to change). Pure string surgery — never
 * round-trips through Date, so a migration can't shift a date by a timezone.
 *
 *   NWS-260701-L-01      → NWS-260701-01
 *   NWS-KYM-260616-L-01  → NWS-KYM-260616-01
 *   AGN-260529-STD-01    → AGN-260529-01
 *   NWS-260701-01        → null   (already type-less)
 *   PP-26-008-L04        → null   (not our format)
 */
export function computeTypeDroppedId(id: string): string | null {
  const p = parseEpisodeId(id)
  if (!p || !p.typeCode) return null
  const seq = String(p.sequence).padStart(2, '0')
  return p.programCode
    ? `${p.outletCode}-${p.programCode}-${p.dateStr}-${seq}`
    : `${p.outletCode}-${p.dateStr}-${seq}`
}

export type MigrationPlanInput = {
  id: string
  bookingCode: string | null
  episodes: Array<{ id: string; episodeId: string }>
}

export type MigrationPlanEntry = {
  bookingId: string
  oldCode: string
  newCode: string
  episodeChanges: EpisodeIdChange[]
}

export type MigrationPlan = {
  /** Bookings safe to migrate (collision-free at the @unique bookingCode level). */
  toApply: MigrationPlanEntry[]
  /** Groups where >1 booking would end up with the same code — these are LEFT
   *  as-is (the user's "keep the colliding pairs"). Each lists every member. */
  collisions: Array<{ finalCode: string; members: Array<{ bookingId: string; currentCode: string; wouldChange: boolean }> }>
  /** Bookings whose code carries no [TYPE] → nothing to drop. */
  unchanged: string[]
  /** Post-migration episodeId values that appear on >1 episode (episodeId is
   *  not @unique so this won't block, but it flags a semantic dupe to review). */
  episodeIdWarnings: Array<{ episodeId: string; count: number }>
}

/**
 * Compute the whole type-drop migration deterministically. Excludes any booking
 * whose new (type-less) bookingCode would collide with another booking's final
 * code — those are reported under `collisions` and left untouched, so the DB's
 * @unique constraint can never be violated.
 */
export function planTypeDropMigration(bookings: MigrationPlanInput[]): MigrationPlan {
  // 1) Which bookings have a code to drop, and to what.
  const newCodeByBooking = new Map<string, string>()
  const unchanged: string[] = []
  for (const b of bookings) {
    const next = b.bookingCode ? computeTypeDroppedId(b.bookingCode) : null
    if (next) newCodeByBooking.set(b.id, next)
    else unchanged.push(b.id)
  }

  // 2) Everyone's FINAL code (changers → new, others → current) and group them.
  const membersByFinal = new Map<string, Array<{ bookingId: string; currentCode: string; wouldChange: boolean }>>()
  for (const b of bookings) {
    const final = newCodeByBooking.get(b.id) ?? b.bookingCode
    if (!final) continue // null bookingCode with nothing to drop — ignore
    const arr = membersByFinal.get(final) ?? []
    arr.push({ bookingId: b.id, currentCode: b.bookingCode ?? '', wouldChange: newCodeByBooking.has(b.id) })
    membersByFinal.set(final, arr)
  }

  // 3) Collisions = final codes claimed by >1 booking. Exclude their changers.
  const collisions: MigrationPlan['collisions'] = []
  const excluded = new Set<string>()
  for (const [finalCode, members] of Array.from(membersByFinal)) {
    if (members.length > 1) {
      collisions.push({ finalCode, members })
      for (const m of members) if (m.wouldChange) excluded.add(m.bookingId)
    }
  }

  // 4) Build the apply list for the survivors + their episode changes.
  const byId = new Map(bookings.map(b => [b.id, b]))
  const toApply: MigrationPlanEntry[] = []
  for (const [bookingId, newCode] of Array.from(newCodeByBooking)) {
    if (excluded.has(bookingId)) continue
    const b = byId.get(bookingId)!
    const episodeChanges: EpisodeIdChange[] = []
    for (const ep of b.episodes) {
      const nextEp = computeTypeDroppedId(ep.episodeId)
      if (nextEp && nextEp !== ep.episodeId) {
        episodeChanges.push({ episodeDbId: ep.id, oldEpisodeId: ep.episodeId, newEpisodeId: nextEp })
      }
    }
    toApply.push({ bookingId, oldCode: b.bookingCode!, newCode, episodeChanges })
  }

  // 5) Warn on post-migration duplicate episodeIds (informational).
  const applyById = new Map(toApply.map(e => [e.bookingId, e]))
  const epFinalCounts = new Map<string, number>()
  for (const b of bookings) {
    const entry = applyById.get(b.id)
    const changeMap = new Map((entry?.episodeChanges ?? []).map(c => [c.episodeDbId, c.newEpisodeId]))
    for (const ep of b.episodes) {
      const finalEp = changeMap.get(ep.id) ?? ep.episodeId
      epFinalCounts.set(finalEp, (epFinalCounts.get(finalEp) ?? 0) + 1)
    }
  }
  const episodeIdWarnings = Array.from(epFinalCounts.entries())
    .filter(([, n]) => n > 1)
    .map(([episodeId, count]) => ({ episodeId, count }))

  return { toApply, collisions, unchanged, episodeIdWarnings }
}
