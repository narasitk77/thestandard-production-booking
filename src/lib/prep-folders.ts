/**
 * v1.86 — pre-create the Drive destination "boxes" for the day's shoots so the
 * folders are waiting (empty CAM-A.. = that camera hasn't delivered yet). The
 * approve route already does this per-booking on CONFIRM; this is the daily/
 * hourly safety-net sweep so EVERY booking shooting today has its folders,
 * regardless of when/whether it was approved. Idempotent — ensureShootCameraFolders
 * reuses existing folders, only creates missing ones. v1.149 — the sweep also
 * writes `_SHOOT.txt` when the booking folder has NONE (approve's one-shot write
 * is best-effort; a transient Drive error used to leave the box permanently
 * invisible to the footage crawler). It never overwrites an existing marker.
 */
import { prisma } from '@/lib/db'
import { ensureShootCameraFolders, ensurePhotoAlbumFolder, ensureSoundStagingFolder, findFoldersByCode, isFootageTreeFolder, listFilesInFolder, listFilesRecursive, upsertTextFile, hasDriveCredentials } from '@/lib/google-drive'
import {
  outletDriveFolderName,
  shootFolderLayers,
  buildBookingFolderName,
  landingBookingFolderName,
  buildEpisodeFolderName,
  camerasToPreCreate,
  hasOutletFolderMapping,
  isPhotoAlbumBooking,
  bookingNeedsSound,
  soundStagingCategoryName,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { renderBookingInfo, bookingInfoInput } from '@/lib/booking-info'
import { CANONICAL_MARKER_NAME, ensureShootMarkerExists } from '@/lib/shoot-marker'
// v1.114 — id-first Drive linkage.
import { rememberDriveLinks } from '@/lib/drive-links'

const SHOOT_FILE_RE = /^_SHOOT.*\.txt$/i

/** v1.149 — create `_SHOOT.txt` when the folder has NO marker at all. Never
 *  overwrites an existing one (approve/regenerate own the content; the nightly
 *  reconciler audits it) — this only fills the hole a failed approve-time write
 *  left. Returns true when a marker was created. */
async function ensureMarkerFile(folderId: string, b: Parameters<typeof bookingInfoInput>[0] & { bookingCode: string | null }): Promise<boolean> {
  try {
    const files = await listFilesInFolder(folderId)
    if (files.some(f => SHOOT_FILE_RE.test(f.name))) return false
    await upsertTextFile({ parentFolderId: folderId, name: CANONICAL_MARKER_NAME, content: renderBookingInfo(bookingInfoInput(b)) })
    return true
  } catch (e: any) {
    console.error('[prep] marker ensure failed (non-fatal):', b.bookingCode, e?.message || e)
    return false
  }
}

/** Half-open range matching bookings whose **Bangkok** shoot-day is today.
 *  `Booking.shootDate` is `@db.Date` (date-only) — Prisma returns/compares it as
 *  midnight-UTC of the calendar date. So we resolve TODAY in Bangkok (now+7h),
 *  then return that date's midnight-UTC boundaries. (An earlier version offset
 *  the boundaries by -7h; against a date column that truncated `end` and
 *  excluded today's shoots — the bug this replaces.) */
export function bangkokTodayRange(now: Date = new Date()): { start: Date; end: Date } {
  const bkk = new Date(now.getTime() + 7 * 3_600_000)
  const start = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) }
}

// v1.139 — the "Production Team" landing drop drive is now owned by the next-day
// landing lifecycle (src/lib/landing-lifecycle.ts); prep-folders only pre-creates
// the VIDEO 2026 box camera folders for today's shoots.

export interface PrepResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  total: number
  prepared: number
  errors: number
  prodTeamErrors: number
  results: Array<{ bookingCode: string | null; created?: string[]; prodTeam?: string; wouldCreate?: string[]; skipped?: string; error?: string }>
}

export async function prepTodayShootFolders(opts: { dryRun?: boolean } = {}): Promise<PrepResult> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', dryRun: !!opts.dryRun, total: 0, prepared: 0, errors: 0, prodTeamErrors: 0, results: [] }
  }

  const { start, end } = bangkokTodayRange()
  const bookings = await prisma.booking.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      bookingCode: { not: null },
    },
    select: {
      id: true, bookingCode: true, cameraCount: true, micCount: true,
      projectId: true, projectName: true, category: true, crewRequired: true,
      // v1.149 — full marker field set: the sweep now also repairs a MISSING
      // `_SHOOT.txt` (approve's write is best-effort and can fail transiently;
      // without this the crawler never saw the shoot at all).
      status: true, videoType: true, shootType: true, shootDate: true, shootEndDate: true,
      callTime: true, estimatedWrap: true, locationName: true,
      producer: true, producerEmail: true, director: true, directorEmail: true,
      mainVideographerEmail: true, assignedEmails: true, agencyRef: true, notes: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { code: true, name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } } },
    },
  })

  const results: PrepResult['results'] = []
  let prepared = 0
  let errors = 0
  let prodTeamErrors = 0

  for (const b of bookings) {
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    // v1.110 — show-first folder names ("<show> · <job> (<code>)").
    const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
    // v1.111 — a booking whose footage ALREADY EXISTS somewhere (matched by its
    // immutable Production ID, wherever ops moved it) is done being prepped:
    // recreating empty skeletons after ops file the delivered footage away just
    // resurrects "ghost" folders (observed loop 2026-07-02: ops move → next
    // prep tick recreates empty landing/box/generic-program trees).
    if (!opts.dryRun && b.bookingCode) {
      try {
        let hasFiles = false
        for (const c of await findFoldersByCode(b.bookingCode)) {
          // v1.149 — only folders in the VIDEO tree (outside _SOUND-STAGING)
          // count as "delivered footage". The staging booking folder shares the
          // "(code)" name shape and the same drive, so one early audio file used
          // to satisfy this check and PERMANENTLY skip creating the video box
          // for a booking whose approve-time pre-create had failed.
          if (!(await isFootageTreeFolder(c.id))) continue
          const some = await listFilesRecursive(c.id, { maxFiles: 4 })
          if (some.some(f => !/^_SHOOT\b.*\.txt$/i.test(f.name))) { hasFiles = true; break }
        }
        if (hasFiles) {
          // v1.149 — footage delivered ≠ marker exists: the exact failure this
          // sweep repairs ("approve's marker write failed") often surfaces AFTER
          // crew uploaded. Ensure the marker (create-only, proper box resolution,
          // never a folder create) before skipping the folder re-prep.
          const marker = await ensureShootMarkerExists(b).catch(e => {
            console.warn('[prep] marker ensure on delivered booking failed (non-fatal):', b.bookingCode, e?.message || e)
            return 'skipped' as const
          })
          results.push({
            bookingCode: b.bookingCode,
            skipped: 'footage already delivered — skip empty re-prep',
            ...(marker === 'updated' ? { created: [CANONICAL_MARKER_NAME] } : {}),
          })
          continue
        }
      } catch (e: any) {
        console.warn('[prep] delivered-check failed (continuing with prep):', b.bookingCode, e?.message || e)
      }
    }
    // v1.108 — Sound-crew bookings: keep a staging tree outside the video project
    // folder (additive, best-effort, in addition to whatever video/photo prep runs).
    if (!opts.dryRun && bookingNeedsSound(b.crewRequired)) {
      // v1.111 — staging is crew-facing (sound team drops files there): use the
      // display-format name, same as the landing folder. Lookups are by code.
      try {
        const { stagingFolderId } = await ensureSoundStagingFolder({
          rootFolderId: root,
          bookingCode: b.bookingCode!,
          bookingFolderName: landingBookingFolderName({ bookingCode: b.bookingCode!, projectName: b.projectName, program: b.program, episodes: b.episodes }),
          // v1.125 — mirrors VIDEO 2026's outlet layer: _SOUND-STAGING/<NN · Outlet>/<รายการ>/<booking>/
          outletFolderName: outletDriveFolderName(b.outlet.code),
          categoryName: soundStagingCategoryName({ outletCode: b.outlet.code, projectName: b.projectName, program: b.program, episodes: b.episodes }),
        })
        await rememberDriveLinks(b.id, { staging: stagingFolderId })
      }
      catch (e: any) { console.error('[prep] sound staging failed (non-fatal):', b.bookingCode, e?.message || e) }
    }
    // v1.102.8 — Photo album jobs → one flat folder in the Photographer Shared
    // Drive (not VIDEO 2026). Handled before the outlet-mapping / camera checks
    // (those are video-only). Idempotent with the approve route's pre-create.
    if (isPhotoAlbumBooking(b.episodes)) {
      const photoName = buildBookingFolderName(b.bookingCode!, jobName, showName)
      if (opts.dryRun) { results.push({ bookingCode: b.bookingCode, wouldCreate: [`(photo) ${photoName}`] }); prepared++; continue }
      try {
        const { bookingFolderId: photoId } = await ensurePhotoAlbumFolder({ bookingCode: b.bookingCode!, bookingFolderName: photoName })
        await rememberDriveLinks(b.id, { photo: photoId })
        const created = [`(photo) ${photoName}`]
        if (await ensureMarkerFile(photoId, b)) created.push(CANONICAL_MARKER_NAME)
        results.push({ bookingCode: b.bookingCode, created })
        prepared++
      } catch (e: any) {
        results.push({ bookingCode: b.bookingCode, error: `photo folder: ${e?.message || e}` })
        errors++
      }
      continue
    }
    if (!hasOutletFolderMapping(b.outlet.code)) {
      results.push({ bookingCode: b.bookingCode, skipped: `outlet ${b.outlet.code} has no folder mapping` })
      continue
    }
    const cameras = camerasToPreCreate(b.cameraCount)
    if (cameras.length === 0) {
      results.push({ bookingCode: b.bookingCode, skipped: 'no cameras (block shot / unspecified)' })
      continue
    }
    if (opts.dryRun) {
      results.push({ bookingCode: b.bookingCode, wouldCreate: cameras })
      prepared++
      continue
    }
    try {
      const isAgency = b.outlet.code === 'AGN'
      // v1.93 — one folder per episode (<…>/<EP>/<camera>/). v1.94 — AGN keys EP
      // folders by project EP ID; empty for bookings with no episodes.
      const episodeFolderNames = b.episodes.length ? b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency })) : undefined
      // v1.94 — AGN groups by Project (no per-booking folder); others by show + ID.
      const layers = shootFolderLayers({
        outletCode: b.outlet.code,
        showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
        category: b.category,
        projectId: b.projectId,
        projectName: b.projectName,
        bookingCode: b.bookingCode!,
        jobName,
      })
      // 1) destination boxes in VIDEO 2026 (AGN: outlet/<Project>/<job (code)>/…;
      //    others: outlet/program/<show · job (code)>/<EP>/CAM-..)
      const { bookingFolderId: boxId } = await ensureShootCameraFolders({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(b.outlet.code),
        programFolderName: layers.programFolderName,
        bookingFolderName: layers.bookingFolderName,
        // v1.112 — AGN: per-booking layer inside the project box.
        bookingSubfolderName: layers.bookingSubfolderName,
        bookingSubfolderCode: b.bookingCode!,
        // AGN box is keyed by projectId (not bookingCode) — v1.149: matched by
        // that projectId (rename/name-drift tolerant), no longer exact-name.
        bookingCode: b.outlet.code === 'AGN' ? undefined : b.bookingCode!,
        bookingFolderCode: b.outlet.code === 'AGN' ? (b.projectId ?? undefined) : undefined,
        cameras,
        episodeFolderNames,
      })
      // 2) v1.139 — the Production Team LANDING drop folder is NO LONGER created
      //    here. It's owned by the next-day landing lifecycle (src/lib/landing-
      //    lifecycle.ts): created the evening before the shoot, cleaned up once the
      //    shoot is past + delivered, so the drop drive stays lean (only upcoming +
      //    in-flight shoots) instead of accumulating a folder per past shoot.
      await rememberDriveLinks(b.id, { box: boxId })
      // v1.149 — approve's `_SHOOT.txt` write is best-effort (fire-and-forget,
      // one shot); if it failed, the box existed but the footage crawler could
      // never see the shoot. The sweep now repairs a missing marker — this is
      // the only automatic recovery path, so keep it inside the success branch
      // (boxId is the per-booking folder: AGN = the v1.112 subfolder).
      const created: string[] = [...cameras]
      if (await ensureMarkerFile(boxId, b)) created.push(CANONICAL_MARKER_NAME)
      results.push({ bookingCode: b.bookingCode, created, prodTeam: 'landing → nightly lifecycle' })
      prepared++
    } catch (e: any) {
      results.push({ bookingCode: b.bookingCode, error: e?.message || String(e) })
      errors++
    }
  }

  return { skipped: false, dryRun: !!opts.dryRun, total: bookings.length, prepared, errors, prodTeamErrors, results }
}
