/**
 * v1.86 — pre-create the Drive destination "boxes" for the day's shoots so the
 * folders are waiting (empty CAM-A.. = that camera hasn't delivered yet). The
 * approve route already does this per-booking on CONFIRM; this is the daily/
 * hourly safety-net sweep so EVERY booking shooting today has its folders,
 * regardless of when/whether it was approved. Idempotent — ensureShootCameraFolders
 * reuses existing folders, only creates missing ones. Creates folders only (no
 * moving, no _SHOOT.txt — approve handles that).
 */
import { prisma } from '@/lib/db'
import { ensureShootCameraFolders, ensureFlatShootFolders, ensurePhotoAlbumFolder, ensureSoundStagingFolder, findFoldersByCode, listFilesRecursive, hasDriveCredentials } from '@/lib/google-drive'
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
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
// v1.114 — id-first Drive linkage.
import { rememberDriveLinks } from '@/lib/drive-links'

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

// v1.88 — "Production Team" landing Shared Drive (where the NAS syncs footage).
// Hardcoded default so it works without a Portainer env change; override with
// DRIVE_PRODUCTION_TEAM_ROOT if the drive ever changes.
const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

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
      outlet: { select: { code: true } },
      program: { select: { name: true } },
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
          const some = await listFilesRecursive(c.id, { maxFiles: 4 })
          if (some.some(f => !/^_SHOOT\b.*\.txt$/i.test(f.name))) { hasFiles = true; break }
        }
        if (hasFiles) {
          results.push({ bookingCode: b.bookingCode, skipped: 'footage already delivered — skip empty re-prep' })
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
        const { stagingFolderId } = await ensureSoundStagingFolder({ rootFolderId: root, bookingCode: b.bookingCode!, bookingFolderName: landingBookingFolderName({ bookingCode: b.bookingCode!, projectName: b.projectName, program: b.program, episodes: b.episodes }) })
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
        results.push({ bookingCode: b.bookingCode, created: [`(photo) ${photoName}`] })
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
    const cameras = camerasToPreCreate(b.cameraCount, b.micCount)
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
        // AGN box is keyed by projectId (not bookingCode) → keep exact-name match.
        bookingCode: b.outlet.code === 'AGN' ? undefined : b.bookingCode!,
        cameras,
        episodeFolderNames,
      })
      // 2) v1.88 — landing folder in Production Team (flat, ALWAYS named by
      //    Production ID — it's a NAS drop zone, identity = the shoot, not the
      //    project). Best-effort: a Production Team hiccup must not undo the box prep.
      //    v1.111 — crew-facing DISPLAY name (real show, no generic Episode-Type
      //    prefix, "-" job dropped); landing matching is by Production ID.
      const landingFolderName = landingBookingFolderName({ bookingCode: b.bookingCode!, projectName: b.projectName, program: b.program, episodes: b.episodes })
      let prodTeam = 'ok'
      let landingId: string | null = null
      try {
        landingId = (await ensureFlatShootFolders({ rootFolderId: PRODUCTION_TEAM_ROOT, bookingCode: b.bookingCode!, bookingFolderName: landingFolderName, cameras, episodeFolderNames })).bookingFolderId
      } catch (ptErr: any) {
        prodTeam = `error: ${ptErr?.message || ptErr}`
        prodTeamErrors++ // v1.92.1 — count it so a total Production Team outage shows in the headline log
      }
      await rememberDriveLinks(b.id, { box: boxId, landing: landingId ?? undefined })
      results.push({ bookingCode: b.bookingCode, created: cameras, prodTeam })
      prepared++
    } catch (e: any) {
      results.push({ bookingCode: b.bookingCode, error: e?.message || String(e) })
      errors++
    }
  }

  return { skipped: false, dryRun: !!opts.dryRun, total: bookings.length, prepared, errors, prodTeamErrors, results }
}
