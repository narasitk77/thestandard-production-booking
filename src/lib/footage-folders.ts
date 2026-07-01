import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, legacyBookingFolderName } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { findEpisodeFolderUrls, listFilesRecursive, type DriveFile } from '@/lib/google-drive'

export interface FootageFolder {
  label: string
  url: string
  fileCount: number
  totalBytes: number
}

/** The booking shape needed to resolve footage folders (read-only path resolution). */
export interface BookingForFootage {
  bookingCode: string | null
  projectId: string | null
  projectName: string | null
  category: string | null
  outlet: { code: string }
  program: { name: string }
  episodes: Array<{ episodeId: string | null; sequence: number; title: string | null; program?: { name: string } | null }>
}

/**
 * v1.102.4 — resolve a booking's footage into the FOLDERS that contain it
 * (label + Drive folder link + file count + total size), by DETERMINISTIC path
 * (read-only, never creates). Shared by the Detect endpoint and the
 * "notify footage ready" action so both surface the exact same links.
 *
 * Aggregates each file up to its TOP-level folder under the scan root (the
 * camera / OB group) so a deep camera-card tree collapses to one clickable row.
 */
export async function resolveFootageFolders(booking: BookingForFootage): Promise<{ folders: FootageFolder[]; fileCount: number; bookingFolderUrl: string | null }> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !booking.bookingCode) return { folders: [], fileCount: 0, bookingFolderUrl: null }

  const isAgency = booking.outlet.code === 'AGN'
  const jobName = booking.projectName?.trim() || booking.episodes[0]?.title?.trim() || null
  const showName = bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes })
  const { programFolderName, bookingFolderName } = shootFolderLayers({
    outletCode: booking.outlet.code,
    showName,
    category: booking.category,
    projectId: booking.projectId,
    projectName: booking.projectName,
    bookingCode: booking.bookingCode,
    jobName,
  })
  const epNames = booking.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency }))

  const resolved = await findEpisodeFolderUrls({
    rootFolderId: root,
    outletCanonicalName: outletDriveFolderName(booking.outlet.code),
    programFolderName,
    bookingFolderName,
    // v1.110 — also accept the pre-rename legacy "<code> · <job>" box (until folders
    // are renamed) + AGN's Production-ID box (new shape, what ops sometimes use).
    bookingFolderNameAlts: [
      legacyBookingFolderName(booking.bookingCode, jobName),
      ...(isAgency ? [buildBookingFolderName(booking.bookingCode, jobName, showName)] : []),
    ],
    episodeFolderNames: epNames,
  })

  // `_SHOOT.txt` / `_SHOOT-<id>.txt` are booking-info files, not footage.
  const isFootage = (f: DriveFile) => !/^_SHOOT\b.*\.txt$/i.test(f.name)

  const folderMap = new Map<string, FootageFolder>()
  const label = (...parts: string[]) => parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ')
  const add = (f: DriveFile, lbl: string) => {
    // Roll up to the TOP-level folder under the scan root (the camera / OB group)
    // so a deep camera-card tree collapses to one row; null topId = file sitting
    // directly in the scan root → fall back to its immediate parent.
    const fid = f.topFolderId ?? f.parents[0]
    if (!fid) return
    const cur = folderMap.get(fid) ?? { label: lbl || '(box)', url: `https://drive.google.com/drive/folders/${fid}`, fileCount: 0, totalBytes: 0 }
    cur.fileCount++
    cur.totalBytes += f.size ?? 0
    folderMap.set(fid, cur)
  }

  if (isAgency) {
    // shared Project box. Scan THIS booking's EP folders (root = the EP folder)…
    const epFolders = resolved.episodes.filter(e => e.folderId)
    await Promise.all(epFolders.map(async e => {
      const raw = await listFilesRecursive(e.folderId!, { maxFiles: 5000 })
      raw.filter(isFootage).forEach(f => add(f, label(e.episodeFolderName, f.folderPath[0] ?? '')))
    }))
    // …PLUS "loose" footage filed directly in the box but NOT under an EP folder
    // (e.g. an event's OB / PGM / Rec.Stream). Skip project-EP folders ("<projectId>-…")
    // so other bookings' EP footage isn't mixed in.
    if (resolved.bookingFolderId) {
      const epPrefix = `${(booking.projectId || '').toLowerCase()}-`
      const loose = await listFilesRecursive(resolved.bookingFolderId, {
        maxFiles: 5000,
        skipFolder: name => !!epPrefix && name.toLowerCase().startsWith(epPrefix),
      })
      loose.filter(isFootage).forEach(f => add(f, label(f.folderPath[0] ?? '')))
    }
  } else if (resolved.bookingFolderId) {
    // unique Production-ID folder → scan it whole; each top-level folder = one row.
    const raw = await listFilesRecursive(resolved.bookingFolderId, { maxFiles: 5000 })
    raw.filter(isFootage).forEach(f => add(f, label(f.folderPath[0] ?? '')))
  }

  const folders = Array.from(folderMap.values()).sort((a, b) => a.label.localeCompare(b.label))
  const fileCount = folders.reduce((n, f) => n + f.fileCount, 0)
  return { folders, fileCount, bookingFolderUrl: resolved.bookingFolderUrl }
}
