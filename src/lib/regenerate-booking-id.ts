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
 *   3. Sheet   — rewrite col A (Production ID) + col Q (Episode IDs) — any booking
 *                with a sheet row (all outlets since v1.148.0)
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
  findFoldersByCode,
  findSoundStagingFolderByCode,
  classifyFootageTreeFolder,
  renameDriveItem,
  moveAndRenameFile,
  ensureProgramPath,
  hasDriveCredentials,
  isFolderAlive,
  getFileName,
  getDriveParentFolderId,
  withDriveRetry,
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
  landingBookingFolderName,
  soundStagingCategoryName,
} from './outlet-folders'
// v1.163 — cross-outlet move. The PLAN lives in move-outlet.ts; this module
// stays the one place an ID actually changes.
import { movePaths, boxNameAcceptable } from './move-outlet'
import { getDriveLink, rememberDriveLinks } from './drive-links'
import { bookingShowName } from './display'
import { refreshShootMarker } from './shoot-marker'
import { updateBookingRow } from './google-sheets'
import { updateCalendarEventDetails } from './google-calendar'
import { logAudit } from './audit'
import { computeTypeDroppedId } from './id-migration'
import type { EpisodeIdChange } from './id-migration'

export type { EpisodeIdChange } from './id-migration'
export { computeTypeDroppedId, planTypeDropMigration } from './id-migration'
export type {
  MigrationPlan,
  MigrationPlanEntry,
  MigrationPlanInput,
} from './id-migration'

type SideEffect = 'renamed' | 'moved' | 'updated' | 'not-found' | 'skipped' | 'error'

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
    /** v1.149 — `_SHOOT.txt` re-rendered from the post-change booking, so the
     *  footage crawler never reads a dead Production ID / stale Episode IDs. */
    driveMarker: SideEffect
    sheet: SideEffect
    calendar: SideEffect
    /** v1.163 — the NAS drop folder is renamed (never moved: that drive is flat)
     *  when a move changes the code. Failure never aborts — a drop zone is not a
     *  system of record. */
    driveLandingFolder: SideEffect
    footageLogRows: number
  }
  /** v1.163 — set when this run also changed the booking's outlet. */
  outletChange?: { from: string; to: string }
  error?: string
}

const NOOP_EFFECTS: RegenerateResult['effects'] = {
  driveBookingFolder: 'skipped',
  driveSoundFolder: 'skipped',
  drivePhotoFolder: 'skipped',
  driveMarker: 'skipped',
  sheet: 'skipped',
  calendar: 'skipped',
  driveLandingFolder: 'skipped',
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
  /** v1.163 — cross-outlet move. Callers MUST pass a plan produced by
   *  `planOutletMove()`; this module never picks an outlet itself, and the
   *  route guarantees `outletCode !== booking.outlet.code`. Supplying this
   *  switches the Drive step from rename-in-place to a verified relocation and
   *  makes an unlocatable box a REFUSAL rather than a silent half-apply. */
  outletMove?: {
    outletId: string; outletCode: string; outletName: string
    bookingProgramId: string; bookingProgramCode: string; bookingProgramName: string
  }
}

/**
 * v1.163 — put a booking box where the plan says it belongs: ensure
 * `<root>/<outletCanon>/<programFolder>` exists, then relocate + rename the box
 * into it in ONE atomic `files.update` (so a failure leaves the folder exactly
 * where a retry looks: old parent, old name).
 *
 * `currentParentId` MUST be the parent actually read from Drive. When the caller
 * needs a relocation and the current parent is unknown, this refuses rather than
 * degrading to a rename-in-place: a rename would give the box the new outlet's
 * name while leaving it physically under the old outlet, and nothing in this
 * codebase ever checks a box's ancestor outlet, so that lie would never be
 * detected or healed.
 */
export async function placeBookingBox(args: {
  boxId: string
  rootFolderId: string
  outletCanonicalName: string
  programFolderName: string
  newName: string
  currentParentId: string | null
  requireRelocation: boolean
}): Promise<'moved' | 'renamed'> {
  const target = await ensureProgramPath(args.rootFolderId, args.outletCanonicalName, args.programFolderName)
  if (args.currentParentId && args.currentParentId !== target) {
    await withDriveRetry(`move box ${args.boxId}`, () =>
      moveAndRenameFile(args.boxId, target, args.currentParentId!, args.newName))
    return 'moved'
  }
  if (!args.currentParentId && args.requireRelocation) {
    throw new Error(`cannot relocate box ${args.boxId}: current parent unreadable`)
  }
  await renameDriveItem(args.boxId, args.newName)
  return 'renamed'
}

/**
 * Regenerate one booking's ID. Returns a structured result; only throws on a
 * programming error — DB collisions and missing bookings come back as ok:false.
 */
export async function regenerateBookingId(opts: RegenerateOptions): Promise<RegenerateResult> {
  const { bookingId, newBookingCode, actorEmail, dryRun = false, notifyCalendar = false } = opts
  const move = opts.outletMove ?? null

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
  if (!codeChanged && episodeChanges.length === 0 && programUpdates.length === 0 && !move) {
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

    // v1.146 review fix — the check above only catches a booking whose CURRENT
    // bookingCode already equals newBookingCode. It misses a "v1.109 collision
    // pair" sibling that hasn't migrated yet: its current code still carries
    // [TYPE], so no literal match exists YET, but its own future type-dropped
    // code would equal newBookingCode. planTypeDropMigration (the bulk planner)
    // catches this by evaluating every booking's pair at once; a single-booking
    // regenerate must run the same pairwise check or it can silently split a
    // pair the bulk migration deliberately left untouched.
    const otherCoded = await prisma.booking.findMany({
      where: { NOT: { id: bookingId }, bookingCode: { not: null } },
      select: { id: true, bookingCode: true },
    })
    const futureClash = otherCoded.find(b => computeTypeDroppedId(b.bookingCode as string) === newBookingCode)
    if (futureClash) {
      return {
        ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun, effects: { ...NOOP_EFFECTS },
        error: `bookingCode "${newBookingCode}" would collide with booking ${futureClash.id} ("${futureClash.bookingCode}") once IT drops its [TYPE] segment too — this is a v1.109 collision pair; both must stay on their legacy codes. See /admin/migrate-ids for the full collision report.`,
      }
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
  // v1.163 — a move must also swap the outlet/program RELATIONS here, not just
  // the code: the calendar title, the _SHOOT marker and the show name all read
  // them off this object. Without the splice the calendar would keep saying
  // [PM] while the ID already said NWS.
  const bookingAfter = {
    ...booking,
    bookingCode: newBookingCode,
    episodes: episodesAfter,
    ...(move ? {
      outletId: move.outletId,
      outlet: { ...booking.outlet, id: move.outletId, code: move.outletCode, name: move.outletName },
      programId: move.bookingProgramId,
      program: { ...booking.program, id: move.bookingProgramId, code: move.bookingProgramCode, name: move.bookingProgramName },
    } : {}),
  }

  // v1.110 — folder names lead with the show; a reprogram (or a move) changes the
  // show, so FIND the folder by the OLD show/code and rename it to the NEW one
  // (the legacy "<code> · <job>" shape is also accepted when finding, so
  // pre-rename folders convert to the show-first shape here too).
  // Hoisted out of the Drive step in v1.163 so the move PREFLIGHT below can use
  // the same values — preview, preflight and execution must never diverge.
  const oldShowName = bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes })
  const newShowName = bookingShowName({ projectName: bookingAfter.projectName, program: bookingAfter.program, episodes: bookingAfter.episodes })

  const effects: RegenerateResult['effects'] = { ...NOOP_EFFECTS }

  // v1.109 — CRITICAL ORDERING: every external side-effect runs BEFORE the DB
  // commit, and a genuine API *error* (not a benign not-found) aborts WITHOUT
  // committing. Because the DB still holds the OLD code on abort, a re-run
  // recomputes the same target and retries the whole cascade cleanly — the
  // operation is fully idempotent + resumable, and footage can never be stranded
  // by a half-done rename (folder + DB stay in the old, consistent state).
  // v1.163 — `message` overrides the English default so the move flow can hand
  // the operator an actionable Thai sentence; `stage` stays English for logs.
  const abort = (stage: string, message?: string): RegenerateResult =>
    ({ ok: false, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: false, effects, error: message ?? `${stage} failed — DB left unchanged, safe to retry` })

  // ── (0) v1.163 — MOVE PREFLIGHT ────────────────────────────────────────────
  // A cross-outlet move can REFUSE (box unlocatable, box hand-filed outside the
  // standard tree, Drive unclassifiable). Those refusals must happen before the
  // sheet and calendar writes: the sheet is a shared surface PMDC's Airtable
  // sync reads, and a refusal after step 1 would leave it advertising a
  // Production ID + Outlet that exist nowhere else, with no rollback.
  //
  // It also matters that NOTHING here mutates Drive — we only resolve and
  // verify. The actual relocation happens in step 3, after sheet+calendar have
  // succeeded, so the window in which the folder and the DB disagree is as
  // small as the code can make it.
  const movePlaces = move
    ? movePaths({
        oldOutletCode: booking.outlet.code,
        newOutletCode: move.outletCode,
        oldShowName, newShowName,
        oldCode: oldCode ?? '', newCode: newBookingCode,
        jobName, category: booking.category, projectId: booking.projectId, projectName: booking.projectName,
      })
    : null
  let moveBoxId: string | null = null
  let moveBoxParentId: string | null = null
  let moveBoxVia: 'stored-id' | 'name-walk' | 'none' = 'none'

  if (move && oldCode && hasDriveCredentials()) {
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (root) {
      try {
        // id-first. Three guards, all required: alive, genuinely inside the
        // footage tree, and still named for the old OR the new code — the new
        // code matters because a previous attempt may have moved+renamed the box
        // and died before the commit; the retry must recognise its own work.
        const stored = process.env.MOVE_OUTLET_ID_FIRST === '0' ? null : getDriveLink(booking.driveFolders, 'box')
        if (stored && await isFolderAlive(stored)) {
          const cls = await classifyFootageTreeFolder(stored)
          if (cls === 'unknown') {
            effects.driveBookingFolder = 'error'
            return abort('Drive footage-tree classification (transient)',
              'ตรวจสอบโฟลเดอร์ Drive ไม่สำเร็จชั่วคราว — ยังไม่ได้แก้อะไรเลย ลองใหม่อีกครั้ง')
          }
          if (cls === 'in-tree') {
            const nm = await getFileName(stored)
            if (nm && boxNameAcceptable(nm, oldCode, newBookingCode)) {
              moveBoxId = stored
              moveBoxParentId = await getDriveParentFolderId(stored)
              moveBoxVia = 'stored-id'
            }
          }
        }
        // Fall back to the name walk under the OLD outlet/program path.
        if (!moveBoxId) {
          const resolved = await findEpisodeFolderUrls({
            rootFolderId: root,
            outletCanonicalName: movePlaces!.oldOutletCanon,
            programFolderName: movePlaces!.oldLayers.programFolderName,
            bookingFolderName: movePlaces!.oldLayers.bookingFolderName,
            bookingFolderNameAlts: [legacyBookingFolderName(oldCode, jobName)],
            episodeFolderNames: [],
          })
          if (resolved.bookingFolderId) {
            moveBoxId = resolved.bookingFolderId
            // Read the REAL parent rather than trusting a recomputed one — the
            // box may sit somewhere the path formula would not predict.
            moveBoxParentId = await getDriveParentFolderId(moveBoxId)
            moveBoxVia = 'name-walk'
          }
        }
        // Still nothing: sweep the drive by the old code. This is the case that
        // must REFUSE rather than half-apply. Committing the new outlet while
        // the box sits under the old one produces the single inconsistency
        // nothing in this repo detects — no worker ever checks that a box's
        // ancestor outlet folder matches the booking's outlet, so it would stay
        // wrong forever and silently.
        if (!moveBoxId) {
          const strays: Array<{ id: string; name: string }> = []
          let anyUnknown = false
          for (const c of await findFoldersByCode(oldCode)) {
            const cls = await classifyFootageTreeFolder(c.id)
            if (cls === 'in-tree') strays.push(c)
            else if (cls === 'unknown') anyUnknown = true
          }
          if (anyUnknown) {
            effects.driveBookingFolder = 'error'
            return abort('Drive footage-tree classification (transient)',
              'ตรวจสอบโฟลเดอร์ Drive ไม่สำเร็จชั่วคราว — ยังไม่ได้แก้อะไรเลย ลองใหม่อีกครั้ง')
          }
          if (strays.length > 0) {
            effects.driveBookingFolder = 'error'
            return abort('Drive box outside the standard path',
              `โฟลเดอร์ Drive ของงานนี้ถูกย้ายไปไว้นอกเส้นทางมาตรฐาน (${strays.map(x => `"${x.name}"`).join(', ')}) — ` +
              'กดปุ่มผูก Drive ID (backfill) ที่ /admin/footage-tools หรือย้ายกลับเข้าที่เดิมก่อน แล้วค่อยย้ายสังกัด · ยังไม่ได้แก้อะไรเลย')
          }
          if (booking.status !== 'REQUESTED') {
            effects.driveBookingFolder = 'error'
            return abort('Drive box not found',
              'หาโฟลเดอร์ Drive ของงานนี้ไม่เจอ — ย้ายสังกัดไม่ได้ (ยังไม่ได้แก้อะไรเลย)')
          }
          // REQUESTED with zero candidates = approve never ran, so no box exists
          // yet. Nothing to move; prep/approve will create it in the right place.
          effects.driveBookingFolder = 'not-found'
        }
      } catch (e: any) {
        console.error('[regenerate] move preflight failed:', e?.message || e)
        effects.driveBookingFolder = 'error'
        return abort('Drive move preflight',
          'ตรวจสอบโฟลเดอร์ Drive ไม่สำเร็จ — ยังไม่ได้แก้อะไรเลย ลองใหม่อีกครั้ง')
      }
    }
  }

  // (1) Producer Dashboard sheet (any booking with a row — all outlets since
  //     v1.148.0). Located by the OLD code, then col A/Q are overwritten with
  //     the new values. 'not-found' is benign (no row, or a prior partial run
  //     already rewrote it); only 'error' aborts.
  if ((codeChanged || move) && oldCode && booking.sheetRowIndex) {
    const newEpisodeIdsJoined = episodesAfter.map(e => e.episodeId).join(', ')
    effects.sheet = await updateBookingRow(oldCode, {
      ...(codeChanged ? { productionId: newBookingCode } : {}),
      ...(episodeChanges.length ? { episodeIds: newEpisodeIdsJoined } : {}),
      // v1.163 — cols D/E. Without these the sheet keeps advertising the OLD
      // outlet next to the NEW Production ID, and PMDC's Airtable sync joins on
      // that column. Display NAMES, matching what the append path writes.
      ...(move ? { outlet: move.outletName, program: move.bookingProgramName } : {}),
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
  if ((codeChanged || move) && oldCode && hasDriveCredentials()) {
    const isPhoto = isPhotoAlbumBooking(booking.episodes)
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
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
      // v1.112 — AGN: the shared project box name is code-agnostic (old === new),
      // but the per-booking layer INSIDE it embeds the code → rename THAT child,
      // or detection/merge would keep matching the dead code.
      if (move) {
        // v1.163 — cross-outlet move. The box was already resolved + verified in
        // the preflight; `moveBoxId === null` there means REQUESTED-with-no-box,
        // which the preflight already recorded as 'not-found'.
        if (moveBoxId) {
          try {
            effects.driveBookingFolder = await placeBookingBox({
              boxId: moveBoxId,
              rootFolderId: root,
              outletCanonicalName: movePlaces!.newOutletCanon,
              programFolderName: movePlaces!.newLayers.programFolderName,
              newName: movePlaces!.newLayers.bookingFolderName,
              currentParentId: moveBoxParentId,
              requireRelocation: movePlaces!.needsMove,
            })
            // Self-heal into the id-first path: a booking resolved by name walk
            // now carries its box id, so nothing has to guess again.
            await rememberDriveLinks(bookingId, { box: moveBoxId })
          } catch (e: any) {
            console.error('[regenerate] booking box move failed:', e?.message || e)
            effects.driveBookingFolder = 'error'
            return abort('Drive booking-folder move',
              'ย้ายโฟลเดอร์ Drive ไม่สำเร็จ — ยังไม่ได้แก้อะไรในระบบ (ชีท/ปฏิทินอาจอัปเดตไปแล้ว จะตรงกันเองเมื่อลองใหม่สำเร็จ)')
          }
        }
      } else if (oldLayers.bookingSubfolderName || newLayers.bookingSubfolderName) {
        try {
          const resolved = await findEpisodeFolderUrls({
            rootFolderId: root,
            outletCanonicalName: outletCanon,
            programFolderName: oldLayers.programFolderName,
            bookingFolderName: oldLayers.bookingFolderName,
            // v1.149 — match the shared project box by projectId too (same as
            // approve/prep/upload): an ops-retitled box otherwise misses, the
            // old-code subfolder never gets renamed, and the next upload/prep
            // creates a new-code twin beside it.
            bookingFolderCode: booking.projectId ?? undefined,
            bookingSubfolderName: oldLayers.bookingSubfolderName,
            bookingSubfolderCode: oldCode,
            episodeFolderNames: [],
          })
          if (resolved.viaBookingSubfolder && resolved.bookingFolderId && newLayers.bookingSubfolderName) {
            await renameDriveItem(resolved.bookingFolderId, newLayers.bookingSubfolderName)
            effects.driveBookingFolder = 'renamed'
          } else {
            // No booking layer yet (legacy/never-prepped) — nothing to rename.
            effects.driveBookingFolder = 'not-found'
          }
        } catch (e: any) {
          console.error('[regenerate] AGN booking-layer rename failed:', e?.message || e)
          effects.driveBookingFolder = 'error'
          return abort('Drive booking-folder rename')
        }
      } else if (oldLayers.bookingFolderName === newLayers.bookingFolderName && samePlace) {
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
            // v1.149 — the box may have been HAND-MOVED out of the deterministic
            // outlet/program path (ops reorganize freely). Before declaring
            // not-found — which commits the new code and orphans a folder still
            // named by the OLD code (a "contains newCode" search can never find
            // it again) — sweep the footage drive by the old code and rename an
            // unambiguous single hit in place (no move; ops chose its location).
            const strays: Array<{ id: string; name: string }> = []
            let anyUnknown = false
            for (const c of await findFoldersByCode(oldCode)) {
              // v1.148.3 — fail-CLOSED for this destructive rename: only an
              // explicit 'in-tree' is a candidate. A transient 'unknown' (Drive
              // error) must never be renamed — it could be a _SOUND-STAGING
              // sibling or a folder we never confirmed.
              const cls = await classifyFootageTreeFolder(c.id)
              if (cls === 'in-tree') strays.push(c)
              else if (cls === 'unknown') anyUnknown = true
            }
            if (anyUnknown) {
              // A candidate couldn't be classified. Renaming now risks the wrong
              // folder, and declaring not-found would commit the new code + orphan
              // the old-named box. Abort like any other Drive error and retry when
              // Drive recovers (idempotent — nothing has been committed yet).
              console.error('[regenerate] footage-tree classification unknown for a candidate — deferring rename')
              effects.driveBookingFolder = 'error'
              return abort('Drive footage-tree classification (transient)')
            }
            if (strays.length === 1) {
              await renameDriveItem(strays[0].id, newLayers.bookingFolderName)
              effects.driveBookingFolder = 'renamed'
            } else {
              // 0 hits = folder never created (REQUESTED) OR already renamed by a
              // prior partial run; >1 = ambiguous — leave for a human. NOT an error.
              effects.driveBookingFolder = 'not-found'
            }
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
        // id-first, then the by-code sweep the sound worker itself uses.
        let fid = getDriveLink(booking.driveFolders, 'staging')
        if (fid && !(await isFolderAlive(fid))) fid = null
        if (!fid && stagingRoot) fid = await findSoundStagingFolderByCode(stagingRoot, oldCode)
        if (fid && move && stagingRoot) {
          // v1.163 — the staging tree is <root>/_SOUND-STAGING/<outlet>/<cat>/<booking>,
          // so a move has to relocate here as well or the sound team's folder
          // stays filed under the old outlet.
          const cat = soundStagingCategoryName({
            outletCode: move.outletCode,
            projectName: booking.projectName,
            program: { code: move.bookingProgramCode, name: move.bookingProgramName },
            episodes: episodesAfter,
          })
          effects.driveSoundFolder = await placeBookingBox({
            boxId: fid, rootFolderId: stagingRoot,
            outletCanonicalName: movePlaces!.newOutletCanon,
            programFolderName: cat,
            newName,
            currentParentId: await getDriveParentFolderId(fid),
            requireRelocation: false, // a flat/legacy staging layout may legitimately have no move to make
          })
          await rememberDriveLinks(bookingId, { staging: fid })
        } else if (fid) {
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

    // (d) v1.163 — NAS drop folder (the flat "Production Team" landing drive).
    //     Every landing create/lookup path keys on the CODE, so a move that
    //     left this folder named by the old code would make the nightly worker
    //     mint a second drop zone beside it and split the crew's footage.
    //     Flat drive → rename only: never move, never create. A failure is
    //     reported, never fatal (a drop zone is not a system of record).
    if (move) {
      const landingRoot = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim()
      try {
        let lid = getDriveLink(booking.driveFolders, 'landing')
        if (lid && !(await isFolderAlive(lid))) lid = null
        if (!lid && landingRoot) lid = await findChildFolderByCode(landingRoot, oldCode)
        if (lid) {
          await renameDriveItem(lid, landingBookingFolderName({
            bookingCode: newBookingCode,
            projectName: booking.projectName,
            program: bookingAfter.program,
            episodes: episodesAfter,
          }))
          await rememberDriveLinks(bookingId, { landing: lid })
          effects.driveLandingFolder = 'renamed'
        } else {
          effects.driveLandingFolder = 'not-found'
        }
      } catch (e: any) {
        console.error('[regenerate] landing rename failed (non-fatal):', e?.message || e)
        effects.driveLandingFolder = 'error'
      }
    }
  }

  // (4) DB — authoritative, transactional, and LAST so any side-effect error
  //     above left the DB (and every derived lookup) untouched + retryable.
  try {
    await prisma.$transaction(async (tx) => {
      // v1.163 — code + outlet + booking-level program go in ONE update. Program
      // is @@unique([code, outletId]); writing outletId without programId would
      // leave booking.program pointing at the OLD outlet's row — a cross-outlet
      // FK that Prisma accepts and nothing in the app validates.
      if (codeChanged || move) {
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            ...(codeChanged ? { bookingCode: newBookingCode } : {}),
            ...(move ? { outletId: move.outletId, programId: move.bookingProgramId } : {}),
          },
        })
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

  // (5) v1.149 — re-render `_SHOOT.txt` from the committed state. The marker was
  //     written once at approve time; without this, a regenerated/reprogrammed
  //     booking's marker keeps the OLD Production ID + Episode IDs forever and
  //     the footage crawler files the shoot under a dead code. Best-effort AFTER
  //     the commit (the DB is already authoritative; a marker failure must not
  //     abort — the nightly marker reconciler is the backstop).
  if (hasDriveCredentials()) {
    try {
      effects.driveMarker = await refreshShootMarker(bookingAfter) === 'updated' ? 'updated' : 'not-found'
    } catch (e: any) {
      console.error('[regenerate] marker refresh failed (reconciler will catch up):', e?.message || e)
      effects.driveMarker = 'error'
    }
  }

  // ── Audit ───────────────────────────────────────────────────────────────
  await logAudit({
    actorEmail,
    action: move ? 'booking.move_outlet' : 'booking.regenerate_id',
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
      // v1.163 — boxId + oldBoxParentId make a manual Drive restore a single
      // files.update if a move ever has to be undone by hand.
      ...(move ? {
        outletChange: { from: booking.outlet.code, to: move.outletCode },
        bookingProgramChange: { fromProgramId: booking.programId, toProgramId: move.bookingProgramId },
        boxVia: moveBoxVia, boxId: moveBoxId, oldBoxParentId: moveBoxParentId,
      } : {}),
      effects,
    },
  })

  return {
    ok: true, bookingId, oldCode, newCode: newBookingCode, episodeChanges, dryRun: false, effects,
    ...(move ? { outletChange: { from: booking.outlet.code, to: move.outletCode } } : {}),
  }
}
