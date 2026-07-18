/**
 * v1.149 — refreshShootMarker(): re-render a booking's `_SHOOT.txt` marker from
 * the CURRENT DB state, into the booking's EXISTING Drive box (find-only — this
 * never creates folders, so merely refreshing a marker can't spawn a skeleton).
 *
 * Why: the marker is the contract the PMC footage crawler reads (Production ID +
 * Episode IDs). It used to be written exactly once, at approve time — so every
 * later identity change (regenerate/reprogram ID, episode-title edit) left a
 * stale marker on Drive and the crawler filed the shoot under a dead ID
 * (Neo memo 2026-07-09, "content drift"). Every path that changes marker-visible
 * state now calls this; the nightly reconciler remains the backstop.
 *
 * Outcomes:
 *   'updated'   — box found, marker upserted (created or overwritten)
 *   'not-found' — the booking has no resolvable box yet (never approved /
 *                 folder renamed beyond recognition) — nothing written
 *   'skipped'   — no bookingCode / Drive not configured
 */
import {
  findEpisodeFolderUrls, findChildFolderByCode, upsertTextFile, listFilesInFolder,
  hasDriveCredentials, DRIVE_PHOTO_ROOT,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, isPhotoAlbumBooking, legacyBookingFolderName,
} from './outlet-folders'
import { renderBookingInfo, bookingInfoInput } from './booking-info'
import { bookingShowName } from './display'

export type MarkerRefreshOutcome = 'updated' | 'not-found' | 'skipped'

export const CANONICAL_MARKER_NAME = '_SHOOT.txt'

/** The booking shape refreshShootMarker needs — the standard "full" include
 *  (outlet + program + episodes with program) that approve/regenerate/PATCH
 *  already load, plus the fields renderBookingInfo prints. */
export interface BookingForMarker {
  bookingCode: string | null
  projectId?: string | null
  projectName?: string | null
  category?: string | null
  videoType?: string | null
  shootType?: string | null
  shootDate: Date
  shootEndDate?: Date | null
  callTime?: string | null
  estimatedWrap?: string | null
  locationName?: string | null
  producer?: string | null
  producerEmail?: string | null
  director?: string | null
  directorEmail?: string | null
  mainVideographerEmail?: string | null
  assignedEmails?: string[]
  crewRequired?: string[]
  agencyRef?: string | null
  notes?: string | null
  outlet: { name: string; code: string }
  program: { code: string; name: string }
  episodes: Array<{
    episodeId: string
    title: string | null
    sequence: number
    program?: { code: string; name: string } | null
  }>
}

/** Resolve the folder the booking's `_SHOOT.txt` belongs in — find-only, never
 *  creates. Returns null when no folder is resolvable (or, for the AGN shared-
 *  project layout, when the per-booking subfolder is missing — writing at
 *  project-box level would recreate the pre-v1.112 box-level-marker mess). */
async function resolveMarkerFolder(b: BookingForMarker & { bookingCode: string }): Promise<string | null> {
  // Photo-album jobs: one flat folder in the Photographer Shared Drive.
  if (isPhotoAlbumBooking(b.episodes)) {
    return findChildFolderByCode(DRIVE_PHOTO_ROOT, b.bookingCode)
  }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root) return null
  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const layers = shootFolderLayers({
    outletCode: b.outlet.code,
    showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
    category: b.category,
    projectId: b.projectId,
    projectName: b.projectName,
    bookingCode: b.bookingCode,
    jobName,
  })
  // Gate the fallbacks on the LAYOUT, not the outlet: an AGN booking WITHOUT a
  // project uses the generic per-booking box and needs the code/legacy-name
  // fallbacks like everyone else. Only the shared-project-box layout (subfolder
  // present) matches the box by exact/subfolder-code instead.
  const isSharedProjectBox = !!layers.bookingSubfolderName
  const resolved = await findEpisodeFolderUrls({
    rootFolderId: root,
    outletCanonicalName: outletDriveFolderName(b.outlet.code),
    programFolderName: layers.programFolderName,
    bookingFolderName: layers.bookingFolderName,
    bookingCode: isSharedProjectBox ? undefined : b.bookingCode,
    // v1.149 — shared project box: last-resort match by projectId (name drift).
    bookingFolderCode: isSharedProjectBox ? b.projectId ?? undefined : undefined,
    bookingFolderNameAlts: isSharedProjectBox ? undefined : [legacyBookingFolderName(b.bookingCode, jobName)],
    bookingSubfolderName: layers.bookingSubfolderName,
    bookingSubfolderCode: b.bookingCode,
    episodeFolderNames: [],
  })
  if (!resolved.bookingFolderId) return null
  if (isSharedProjectBox && !resolved.viaBookingSubfolder) return null
  return resolved.bookingFolderId
}

function markerContentFor(b: BookingForMarker): string {
  return renderBookingInfo(bookingInfoInput({
    ...b,
    assignedEmails: b.assignedEmails ?? [],
    crewRequired: b.crewRequired ?? [],
  }))
}

export async function refreshShootMarker(b: BookingForMarker): Promise<MarkerRefreshOutcome> {
  if (!b.bookingCode || !hasDriveCredentials()) return 'skipped'
  const folderId = await resolveMarkerFolder(b as BookingForMarker & { bookingCode: string })
  if (!folderId) return 'not-found'
  await upsertTextFile({ parentFolderId: folderId, name: CANONICAL_MARKER_NAME, content: markerContentFor(b) })
  return 'updated'
}

/** Create `_SHOOT.txt` ONLY when the booking's folder has no marker at all —
 *  never overwrites (approve/regenerate own the content; the reconciler audits
 *  it). For sweeps that must not churn existing markers on every tick. */
export async function ensureShootMarkerExists(b: BookingForMarker): Promise<MarkerRefreshOutcome> {
  if (!b.bookingCode || !hasDriveCredentials()) return 'skipped'
  const folderId = await resolveMarkerFolder(b as BookingForMarker & { bookingCode: string })
  if (!folderId) return 'not-found'
  const files = await listFilesInFolder(folderId)
  if (files.some(f => /^_SHOOT.*\.txt$/i.test(f.name))) return 'skipped'
  await upsertTextFile({ parentFolderId: folderId, name: CANONICAL_MARKER_NAME, content: markerContentFor(b) })
  return 'updated'
}
