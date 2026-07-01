/**
 * Reprogram an episode (v1.109) — change which show/รายการ an episode belongs to
 * (or ADD a program code to an ID that has none) and recompute its Episode ID
 * accordingly, then the caller hands the result to `regenerateBookingId` to
 * cascade the rename to Drive/Sheet/Calendar.
 *
 * The recomputed ID mirrors create-booking.ts EXACTLY so a reprogrammed ID is
 * indistinguishable from one minted at booking time:
 *   - program segment is included only when the episode's program is a real
 *     show code (2–4 alnum) AND differs from the booking-level program
 *     (`booking.program.code`) — identical to create-booking's `progForId` rule;
 *   - the sequence is freshly drawn from the target outlet+program+date stream
 *     (max existing + 1), EXCLUDING the episodes being changed so they don't
 *     inflate their own stream, so the new ID can never collide.
 *
 * Content Agency (AGN) is rejected: its episodes are pre-existing project episode
 * IDs (PP-…), not app-minted, so reprogramming them here is meaningless.
 */
import { prisma } from './db'
import { parseEpisodeId, generateEpisodeId, formatShootDateForId } from './episode-id'
import { getProgram } from './data'
import type { EpisodeIdChange } from './id-migration'

export type ReprogramPlan =
  | { ok: false; error: string }
  | {
      ok: true
      newBookingCode: string
      episodeChanges: EpisodeIdChange[]
      /** episode DB id → the Program DB id it should point to after the change. */
      programUpdates: Array<{ episodeDbId: string; programId: string; programCode: string }>
    }

/**
 * Compute the reprogram plan. `programByEpisodeDbId` maps an episode's DB id to
 * the NEW program code (outlet-scoped). Episodes not present keep their program.
 */
export async function planReprogram(
  bookingId: string,
  programByEpisodeDbId: Record<string, string>,
): Promise<ReprogramPlan> {
  const changedIds = Object.keys(programByEpisodeDbId || {})
  if (changedIds.length === 0) return { ok: false, error: 'No episode program changes given' }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      outlet: true,
      program: { select: { code: true } },
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true } } } },
    },
  })
  if (!booking) return { ok: false, error: 'Booking not found' }
  if (!booking.bookingCode) return { ok: false, error: 'Booking has no code' }
  if (booking.outlet.code === 'AGN') {
    return { ok: false, error: 'Content Agency ใช้ Episode ID ของ project (PP-…) — เปลี่ยนรายการที่นี่ไม่ได้' }
  }

  const outletCode = booking.outlet.code
  const bookingProgCode = (booking.program?.code || '').trim().toUpperCase()
  const dateStr = formatShootDateForId(booking.shootDate)

  // Validate every requested program + resolve/ensure its DB row.
  const programUpdates: Array<{ episodeDbId: string; programId: string; programCode: string }> = []
  const targetProgByEp = new Map<string, string>() // episode DB id -> upper program code
  for (const ep of booking.episodes) {
    const raw = programByEpisodeDbId[ep.id]
    if (raw === undefined) continue
    const code = String(raw).trim().toUpperCase()
    const prog = getProgram(outletCode, code)
    if (!prog) return { ok: false, error: `ไม่รู้จักรายการ "${code}" ของ ${outletCode}` }
    // ID recompute always uses the target program (even if unchanged, so an
    // explicit reprogram to the same show still re-derives a clean ID).
    targetProgByEp.set(ep.id, code)
    // Only record a programId reassignment when the show actually changes — a
    // no-op program (same code) must not count as a change on its own.
    if (code !== (ep.program?.code || '').trim().toUpperCase()) {
      const programDb = await prisma.program.upsert({
        where: { code_outletId: { code: prog.code, outletId: booking.outletId } },
        update: {},
        create: { code: prog.code, name: prog.name, category: prog.category, outletId: booking.outletId },
      })
      programUpdates.push({ episodeDbId: ep.id, programId: programDb.id, programCode: code })
    }
  }

  // Assign fresh, collision-free sequences per target stream.
  const nextSeqByStream = new Map<string, number>()
  const changedSet = new Set(changedIds)
  const episodeChanges: EpisodeIdChange[] = []

  for (const ep of booking.episodes) {
    if (!targetProgByEp.has(ep.id)) continue
    const code = targetProgByEp.get(ep.id)!
    // progForId — identical rule to create-booking.ts.
    const progForId = /^[A-Z0-9]{2,4}$/.test(code) && code !== bookingProgCode ? code : null
    const streamKey = progForId ?? ''

    let nextSeq = nextSeqByStream.get(streamKey)
    if (nextSeq === undefined) {
      const prefix = progForId ? `${outletCode}-${progForId}-${dateStr}-` : `${outletCode}-${dateStr}-`
      const prior = await prisma.episode.findMany({
        where: { episodeId: { startsWith: prefix } },
        select: { id: true, episodeId: true },
      })
      nextSeq = prior.reduce((mx, e) => {
        if (changedSet.has(e.id)) return mx // don't let a changed ep inflate its own stream
        const p = parseEpisodeId(e.episodeId)
        return p && p.sequence > mx ? p.sequence : mx
      }, 0) + 1
    }
    nextSeqByStream.set(streamKey, nextSeq + 1)

    const newEpisodeId = generateEpisodeId(outletCode, booking.shootDate, nextSeq, progForId)
    if (newEpisodeId !== ep.episodeId) {
      episodeChanges.push({ episodeDbId: ep.id, oldEpisodeId: ep.episodeId, newEpisodeId })
    }
  }

  if (episodeChanges.length === 0 && programUpdates.length === 0) {
    return { ok: false, error: 'ไม่มีอะไรเปลี่ยน (รายการที่เลือกให้ ID เดิม)' }
  }

  // Non-AGN: bookingCode mirrors episodes[0]. If episode[0] changed, the booking
  // code follows it; otherwise it stays.
  const firstEp = booking.episodes[0]
  const firstChange = episodeChanges.find(c => c.episodeDbId === firstEp?.id)
  const newBookingCode = firstChange ? firstChange.newEpisodeId : booking.bookingCode

  return { ok: true, newBookingCode, episodeChanges, programUpdates }
}
