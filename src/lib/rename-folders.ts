/**
 * v1.110 — one-off: rename existing Drive folders from the legacy "<code> · <job>"
 * shape to the show-first "<show> · <job> (<code>)" shape, applying the same
 * job-name cleanup (strip the van/logistics parenthetical). Covers the per-booking
 * VIDEO box (non-AGN), the sound-staging folder, the photo-album folder, and the
 * flat Production Team landing folder. The AGN project box (shared, projectId-keyed)
 * is intentionally left alone.
 *
 * Idempotent + safe: each folder is looked up by its immutable Production ID
 * (findChildFolderByCode / findEpisodeFolderUrls with a legacy alt), and renamed
 * ONLY if its current name differs from the target — so re-running is a no-op.
 * dryRun reports the exact "old → new" changes without touching Drive.
 */
import { prisma } from './db'
import {
  findEpisodeFolderUrls, findChildFolder, findChildFolderByCode, getFileName, renameDriveItem,
  hasDriveCredentials, DRIVE_PHOTO_ROOT, SOUND_STAGING_DIR,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildBookingFolderName, legacyBookingFolderName,
  isPhotoAlbumBooking, bookingNeedsSound,
} from './outlet-folders'
import { bookingShowName } from './display'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

export interface FolderRenameResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  bookings: number
  renamed: number
  alreadyOk: number
  errors: number
  results: Array<{ bookingCode: string | null; changes?: string[]; error?: string }>
}

export async function runFolderRename(opts: { dryRun?: boolean } = {}): Promise<FolderRenameResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, renamed: 0, alreadyOk: 0, errors: 0, results: [] as FolderRenameResult['results'] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', ...base }

  const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR) // may be null

  const bookings = await prisma.booking.findMany({
    where: { bookingCode: { not: null } },
    select: {
      bookingCode: true, projectId: true, projectName: true, category: true, crewRequired: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } } },
    },
  })

  // Rename one folder (by id) to newName only if it currently differs.
  const renameIfDiff = async (fileId: string, newName: string, label: string, changes: string[]): Promise<'renamed' | 'ok' | 'error'> => {
    try {
      const cur = await getFileName(fileId)
      if (cur === newName) return 'ok'
      changes.push(`${label}: "${cur}" → "${newName}"`)
      if (!base.dryRun) await renameDriveItem(fileId, newName)
      return 'renamed'
    } catch (e: any) {
      changes.push(`${label}: ERROR ${e?.message || e}`)
      return 'error'
    }
  }
  const tally = (r: 'renamed' | 'ok' | 'error') => {
    if (r === 'renamed') base.renamed++
    else if (r === 'ok') base.alreadyOk++
    else base.errors++
  }

  for (const b of bookings) {
    if (!b.bookingCode) continue
    base.bookings++
    const code = b.bookingCode
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
    const isAgency = b.outlet.code === 'AGN'
    const isPhoto = isPhotoAlbumBooking(b.episodes)
    const changes: string[] = []
    try {
      // (a) main VIDEO box — non-AGN, non-photo (AGN's shared project box is left as-is).
      if (!isAgency && !isPhoto) {
        const { programFolderName, bookingFolderName: newName } = shootFolderLayers({
          outletCode: b.outlet.code, showName, category: b.category,
          projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
        })
        const resolved = await findEpisodeFolderUrls({
          rootFolderId: root, outletCanonicalName: outletDriveFolderName(b.outlet.code), programFolderName,
          bookingFolderName: newName, bookingFolderNameAlts: [legacyBookingFolderName(code, jobName)], episodeFolderNames: [],
        })
        if (resolved.bookingFolderId) tally(await renameIfDiff(resolved.bookingFolderId, newName, 'box', changes))
      }
      // (b) sound-staging folder (any outlet with Sound crew).
      if (stagingRoot && bookingNeedsSound(b.crewRequired)) {
        const fid = await findChildFolderByCode(stagingRoot, code)
        if (fid) tally(await renameIfDiff(fid, buildBookingFolderName(code, jobName, showName), 'sound', changes))
      }
      // (c) photo-album folder.
      if (isPhoto) {
        const fid = await findChildFolderByCode(DRIVE_PHOTO_ROOT, code)
        if (fid) tally(await renameIfDiff(fid, buildBookingFolderName(code, jobName, showName), 'photo', changes))
      }
      // (d) flat Production Team landing folder (all outlets).
      const landId = await findChildFolderByCode(PRODUCTION_TEAM_ROOT, code)
      if (landId) tally(await renameIfDiff(landId, buildBookingFolderName(code, jobName, showName), 'landing', changes))

      if (changes.length) base.results.push({ bookingCode: code, changes })
    } catch (e: any) {
      base.errors++
      base.results.push({ bookingCode: code, error: e?.message || String(e) })
    }
  }

  return { skipped: false, ...base }
}
