/**
 * Regenerate a booking's Production/Episode ID everywhere it lives (v1.109).
 *
 * A booking's human-facing ID (`Booking.bookingCode`, and for non-AGN the linked
 * `Episode.episodeId`s) was historically treated as immutable. This module is the
 * ONE place that changes it safely, cascading to every store that copies the string:
 *
 *   1. DB      — Booking.bookingCode (+ Episode.episodeId, + FootageLog.productionId)
 *   2. Drive   — rename the booking box folder (non-AGN), the sound-staging folder,
 *                and the photo-album folder (all named by the code)
 *   3. Sheet   — rewrite col A (Production ID) + col Q (Episode IDs) — AGN only
 *   4. Calendar— rebuild the event title/description (no attendee notification)
 *
 * DB is authoritative and updated in a transaction; the external side-effects are
 * best-effort (mirrors the approve flow) and each reports its own status so a
 * caller/migration can see exactly what happened.
 *
 * AGN nuance: the Drive box for Content Agency is keyed by `projectId`, not the
 * booking code, so its main folder is NOT renamed; its sheet row IS. Non-AGN is
 * the reverse (folder renamed, no sheet row). The code below derives which apply
 * from the same helpers the approve/create flows use, so it never drifts.
 */
import { prisma } from './db'
import {
  findEpisodeFolderUrls,
  findChildFolder,
  findChildFolderByCode,
  renameDriveItem,
  moveAndRenameFile,
  ensureProgramPath,
  hasDriveCredentials,
  DRIVE_PHOTO_ROOT,
  SOUND_STAGING_DIR,
} from './google-drive'
import {
  outletDriveFolderName,
  shootFolderLayers,
  buildBookingFolderName,
  legacyBookingFolderName,
  isPhotoAlbumBooking,
  bookingNeedsSound,
} from './outlet-folders'
import { bookingShowName } from './display'
import { updateBookingRow } from './google-sheets'
import { updateCalendarEventDetails } from './google-calendar'
import { logAudit } from './audit'
import type { EpisodeIdChange } from './id-migration'

export type { EpisodeIdChange } from './id-migration'
export { computeTypeDroppedId, planTypeDropMigration } from './id-migration'
export type {
  MigrationPlan,
  MigrationPlanEntry,
  MigrationPlanInput,
} from './id-migration'

type SideEffect = 'renamed' | 'updated' | 'not-found' | 'skipped' | 'error'

export type RegenerateResult = {
  ok: boolean
  bookingId: string
  oldCode: string | null
  newCode: string
  episodeChanges: EpisodeIdChange[]
  dryRun: boolean
  effects: {
    driveBookingFolder: SideEffect
    driveSoundFolder: SideEffect
    drivePhotoFolder: SideEffect
    sheet: SideEffect
    calendar: SideEffect
    footageLogRows: number
  }
  error?: string
}

const NOOP_EFFECTS: RegenerateResult['effects'] = {
  driveBookingFolder: 'skipped',
  driveSoundFolder: 'skipped',
  drivePhotoFolder: 'skipped',
  sheet: 'skipped',
  calendar: 'skipped',
  footageLogRows: 0,
}

export type RegenerateOptions = {
  bookingId: string
  newBookingCode: string
  /** Episodes whose episodeId changes (usually [0] mirrors bookingCode for non-AGN). */
  episodeChanges?: Array<{ episodeDbId: string; newEpisodeId: string }>
  /** v1.109 — episodes whose program (รายการ) is reassigned, applied in the same
   *  DB transaction as the ID change (reprogram flow). programCode/programName let
   *  the in-memory calendar rebuild show the NEW show name (not the stale one). */
  programUpdates?: Array<{ episodeDbId: string; programId: string; programCode?: string; programName?: string }>
  actorEmail: string
  /** Compute the plan + validate collisions but touch nothing. */
  dryRun?: boolean
  /** Notify calendar attendees of the change. Default false (an ID rewrite is
   *  not a schedule change — don't email crew, especially during a bulk run). */
  notifyCalendar?: boolean
}

/**
 * Regenerate one booking's ID. Returns a structured result; only throws on a
 * programming error — DB collisions and missing bookings come back as ok:false.
 */
export async function regenerateBookingId(opts: RegenerateOptions): Promise<RegenerateResult> {
  const { bookingId, newBookingCode, actorEmail, dryRun = false, notifyCalendar = false } = opts

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
    },
  })
  if (!booking) {
    return { ok: false, bookingId, oldCode: null, newCode: newBookingCode, episodeChanges: [], dryRun, effects: { ...NOOP_EFFECTS }, error: 'Booking not found' }
  }

  const oldCode = booking.bookingCode

  // Resolve requested episode changes against the real episode rows.
  const epById = new Map(booking.episodes.map(e => [e.id, e]))
  const episodeChanges: EpisodeIdChange[] = []
  for (const c of opts.episodeChanges ?? []) {
    const ep = epById.get(c.episodeDbId)
    if (!ep) {
      return { ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges: [], dryRun, effects: { ...NOOP_EFFECTS }, error: `Episode ${c.episodeDbId} not on booking ${bookingId}` }
    }
    if (ep.episodeId !== c.newEpisodeId) {
      episodeChanges.push({ episodeDbId: ep.id, oldEpisodeId: ep.episodeId, newEpisodeId: c.newEpisodeId })
    }
  }

  // Program (รายการ) reassignments applied in the same DB transaction (reprogram).
  const programUpdates = (opts.programUpdates ?? []).filter(p => epById.has(p.episodeDbId))

  const codeChanged = !!newBookingCode && newBookingCode !== oldCode
  if (!codeChanged && episodeChanges.length === 0 && programUpdates.length === 0) {
    return { ok: true, bookingId, oldCode, newCode: newBookingCode, episodeChanges: [], dryRun, effects: { ...NOOP_EFFECTS }, error: 'No change' }
  }

  // Collision guard: bookingCode is @unique. Reject if another booking already
  // holds the target code (the migration excludes these up front; this is the
  // last line of defence so we never throw a raw P2002 mid-cascade).
  if (codeChanged) {
    const clash = await prisma.booking.findFirst({
      where: { bookingCode: newBookingCode, NOT: { id: bookingId } },
      select: { id: true },
    })
    if (clash) {
      return { ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun, effects: { ...NOOP_EFFECTS }, error: `bookingCode "${newBookingCode}" already used by booking ${clash.id}` }
    }
  }

  if (dryRun) {
    return { ok: true, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: true, effects: { ...NOOP_EFFECTS } }
  }

  // Build the post-change booking view IN MEMORY (DB not yet written) so the
  // calendar rebuild + sheet write use the NEW code + episode ids.
  const jobName = booking.projectName?.trim() || booking.episodes[0]?.title?.trim() || null
  const changeById = new Map(episodeChanges.map(c => [c.episodeDbId, c.newEpisodeId]))
  // v1.109 — also refresh the episode's program relation for reprogrammed episodes
  // so the in-memory calendar rebuild renders the NEW show name (bookingShowName
  // reads episodes[].program.name), not the stale one loaded before the change.
  const progById = new Map(
    programUpdates
      .filter(p => p.programCode)
      .map(p => [p.episodeDbId, { code: p.programCode!, name: p.programName ?? p.programCode! }]),
  )
  const episodesAfter = booking.episodes.map(e => {
    const newEpId = changeById.get(e.id)
    const newProg = progById.get(e.id)
    if (!newEpId && !newProg) return e
    return { ...e, ...(newEpId ? { episodeId: newEpId } : {}), ...(newProg ? { program: newProg } : {}) }
  })
  const bookingAfter = { ...booking, bookingCode: newBookingCode, episodes: episodesAfter }

  const effects: RegenerateResult['effects'] = { ...NOOP_EFFECTS }

  // v1.109 — CRITICAL ORDERING: every external side-effect runs BEFORE the DB
  // commit, and a genuine API *error* (not a benign not-found) aborts WITHOUT
  // committing. Because the DB still holds the OLD code on abort, a re-run
  // recomputes the same target and retries the whole cascade cleanly — the
  // operation is fully idempotent + resumable, and footage can never be stranded
  // by a half-done rename (folder + DB stay in the old, consistent state).
  const abort = (stage: string): RegenerateResult =>
    ({ ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: false, effects, error: `${stage} failed — DB left unchanged, safe to retry` })

  // (1) Producer Dashboard sheet (AGN rows only). Located by the OLD code, then
  //     col A/Q are overwritten with the new values. 'not-found' is benign (no
  //     row, or a prior partial run already rewrote it); only 'error' aborts.
  if (codeChanged && oldCode && booking.sheetRowIndex) {
    const newEpisodeIdsJoined = episodesAfter.map(e => e.episodeId).join(', ')
    effects.sheet = await updateBookingRow(oldCode, {
      productionId: newBookingCode,
      ...(episodeChanges.length ? { episodeIds: newEpisodeIdsJoined } : {}),
    })
    if (effects.sheet === 'error') return abort('sheet update')
  }

  // (2) Calendar event — rebuild title/description from the NEW values. Idempotent
  //     (same event, same content) so a retry is safe. Failure aborts.
  if (booking.calendarEventId) {
    const ok = await updateCalendarEventDetails(booking.calendarEventId, bookingAfter, {
      sendUpdates: notifyCalendar ? 'all' : 'none',
    })
    effects.calendar = ok ? 'updated' : 'error'
    if (!ok) return abort('calendar update')
  }

  // (3) Drive folder renames — done LAST among side-effects so the folder/DB
  //     mismatch window before the commit is as small as possible.
  if (codeChanged && oldCode && hasDriveCredentials()) {
    const isPhoto = isPhotoAlbumBooking(booking.episodes)
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    // v1.110 — folder names lead with the show; a reprogram changes the show, so
    // FIND the folder by the OLD show/code and rename it to the NEW show/code (the
    // legacy "<code> · <job>" shape is also accepted when finding, so pre-rename
    // folders convert to the show-first shape here too).
    const oldShowName = bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes })
    const newShowName = bookingShowName({ projectName: bookingAfter.projectName, program: bookingAfter.program, episodes: bookingAfter.episodes })

    // (a) main booking box — VIDEO tree, non-photo. AGN's box is keyed by
    //     projectId so old === new and this is skipped automatically.
    if (!isPhoto && root) {
      const baseArgs = {
        outletCode: booking.outlet.code,
        category: booking.category,
        projectId: booking.projectId,
        projectName: booking.projectName,
        jobName,
      }
      const outletCanon = outletDriveFolderName(booking.outlet.code)
      const oldLayers = shootFolderLayers({ ...baseArgs, showName: oldShowName, bookingCode: oldCode })
      const newLayers = shootFolderLayers({ ...baseArgs, showName: newShowName, bookingCode: newBookingCode })
      // A reprogram that changes the show also changes the program-layer folder,
      // so the box must MOVE (not just rename) into the new show's folder.
      const samePlace = oldLayers.programFolderName === newLayers.programFolderName
      if (oldLayers.bookingFolderName === newLayers.bookingFolderName && samePlace) {
        effects.driveBookingFolder = 'skipped'
      } else {
        try {
          // FIND under the OLD show's program folder (where the box physically sits),
          // tolerating the pre-v1.110 "<code> · <job>" name.
          const resolved = await findEpisodeFolderUrls({
            rootFolderId: root,
            outletCanonicalName: outletCanon,
            programFolderName: oldLayers.programFolderName,
            bookingFolderName: oldLayers.bookingFolderName,
            bookingFolderNameAlts: [legacyBookingFolderName(oldCode, jobName)], // pre-v1.110 box
            episodeFolderNames: [],
          })
          if (resolved.bookingFolderId) {
            let moved = false
            if (!samePlace && resolved.programFolderId) {
              // Show changed → relocate the box under the NEW show's program folder,
              // AND rename, in ONE atomic files.update so a failure leaves the box
              // untouched (old parent + old name) — exactly where a retry looks.
              const newProgramId = await ensureProgramPath(root, outletCanon, newLayers.programFolderName)
              if (newProgramId !== resolved.programFolderId) {
                await moveAndRenameFile(resolved.bookingFolderId, newProgramId, resolved.programFolderId, newLayers.bookingFolderName)
                moved = true
              }
            }
            if (!moved) await renameDriveItem(resolved.bookingFolderId, newLayers.bookingFolderName)
            effects.driveBookingFolder = 'renamed'
          } else {
            // Not found = folder never created (REQUESTED) OR already renamed by a
            // prior partial run. Either way nothing to do — NOT an error.
            effects.driveBookingFolder = 'not-found'
          }
        } catch (e: any) {
          console.error('[regenerate] booking folder rename failed:', e?.message || e)
          effects.driveBookingFolder = 'error'
          return abort('Drive booking-folder rename')
        }
      }
    }

    // (b) sound-staging folder — <root>/_SOUND-STAGING/<name> — any outlet.
    if (root && bookingNeedsSound(booking.crewRequired)) {
      try {
        const newName = buildBookingFolderName(newBookingCode, jobName, newShowName)
        const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
        const fid = stagingRoot ? await findChildFolderByCode(stagingRoot, oldCode) : null
        if (fid) {
          await renameDriveItem(fid, newName)
          effects.driveSoundFolder = 'renamed'
        } else {
          effects.driveSoundFolder = 'not-found'
        }
      } catch (e: any) {
        console.error('[regenerate] sound-staging rename failed:', e?.message || e)
        effects.driveSoundFolder = 'error'
        return abort('Drive sound-staging rename')
      }
    }

    // (c) photo-album folder — flat under the Photographer Shared Drive.
    if (isPhoto) {
      try {
        const newName = buildBookingFolderName(newBookingCode, jobName, newShowName)
        const fid = await findChildFolderByCode(DRIVE_PHOTO_ROOT, oldCode)
        if (fid) {
          await renameDriveItem(fid, newName)
          effects.drivePhotoFolder = 'renamed'
        } else {
          effects.drivePhotoFolder = 'not-found'
        }
      } catch (e: any) {
        console.error('[regenerate] photo folder rename failed:', e?.message || e)
        effects.drivePhotoFolder = 'error'
        return abort('Drive photo-folder rename')
      }
    }
  }

  // (4) DB — authoritative, transactional, and LAST so any side-effect error
  //     above left the DB (and every derived lookup) untouched + retryable.
  try {
    await prisma.$transaction(async (tx) => {
      if (codeChanged) {
        await tx.booking.update({ where: { id: bookingId }, data: { bookingCode: newBookingCode } })
      }
      for (const c of episodeChanges) {
        await tx.episode.update({ where: { id: c.episodeDbId }, data: { episodeId: c.newEpisodeId } })
      }
      for (const p of programUpdates) {
        await tx.episode.update({ where: { id: p.episodeDbId }, data: { programId: p.programId } })
      }
      if (codeChanged && oldCode) {
        const fl = await tx.footageLog.updateMany({ where: { bookingId }, data: { productionId: newBookingCode } })
        effects.footageLogRows = fl.count
      }
    })
  } catch (e: any) {
    return { ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: false, effects, error: `DB update failed: ${e?.message || e}` }
  }

  // ── Audit ───────────────────────────────────────────────────────────────
  await logAudit({
    actorEmail,
    action: 'booking.regenerate_id',
    entityType: 'Booking',
    entityId: bookingId,
    bookingCode: newBookingCode,
    changes: {
      oldCode,
      newCode: newBookingCode,
      episodeChanges: episodeChanges.map(c => ({ from: c.oldEpisodeId, to: c.newEpisodeId })),
      // v1.109 — capture the show/รายการ reassignment (the point of a reprogram),
      // which the ID-only audit above would otherwise miss.
      ...(programUpdates.length ? {
        programChanges: programUpdates.map(p => ({
          episodeDbId: p.episodeDbId,
          from: epById.get(p.episodeDbId)?.program?.code ?? null,
          to: p.programCode ?? null,
        })),
      } : {}),
      effects,
    },
  })

  return { ok: true, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: false, effects }
}
