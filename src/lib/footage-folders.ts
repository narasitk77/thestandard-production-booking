import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, legacyBookingFolderName, bookingNeedsSound } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { findEpisodeFolderUrls, findFoldersByCode, listFilesRecursive, findChildFolder, findSoundStagingFolderByCode, SOUND_STAGING_DIR, type DriveFile } from '@/lib/google-drive'
import { prisma } from '@/lib/db'
// v1.114 — id-first: a stored box ID skips the whole name-resolution walk.
import { getDriveLink } from '@/lib/drive-links'
import { isFolderAlive } from '@/lib/google-drive'

export interface FootageFolder {
  label: string
  url: string
  fileCount: number
  totalBytes: number
}

/** The booking shape needed to resolve footage folders (read-only path resolution). */
export interface BookingForFootage {
  driveFolders?: unknown
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
  const layers = shootFolderLayers({
    outletCode: booking.outlet.code,
    showName,
    category: booking.category,
    projectId: booking.projectId,
    projectName: booking.projectName,
    bookingCode: booking.bookingCode,
    jobName,
  })
  const programFolderName = layers.programFolderName
  const epNames = booking.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency }))

  // v1.111 — for AGN, PREFER the per-booking box named by the AGN booking code
  // (so a booking's footage is found by its own booking ID), and fall back to the
  // shared "<projectId> · <project>" box. Ordering matters: findEpisodeFolderUrls
  // returns the FIRST matching name, so a per-booking box must be tried before the
  // shared one. Non-AGN is unchanged (show-first primary, legacy alt).
  const bookingCodeName = legacyBookingFolderName(booking.bookingCode, jobName)
  const bookingFolderName = isAgency ? bookingCodeName : layers.bookingFolderName
  const bookingFolderNameAlts = isAgency
    ? [layers.bookingFolderName, buildBookingFolderName(booking.bookingCode, jobName, showName)]
    : [bookingCodeName]

  // v1.114 — id-first: when the booking already knows its box ID (and it's
  // alive), skip the outlet→program→box name walk entirely. For AGN the stored
  // box IS the per-booking layer, so a whole-tree scan is per-booking safe.
  const boxLink = getDriveLink(booking.driveFolders, 'box')
  const liveBoxId = boxLink && await isFolderAlive(boxLink) ? boxLink : null

  const resolved = liveBoxId
    ? { programFolderId: null, bookingFolderId: liveBoxId, bookingFolderUrl: `https://drive.google.com/drive/folders/${liveBoxId}`, viaBookingSubfolder: true, episodes: [] as Array<{ episodeFolderName: string; folderId: string | null; url: string | null }> }
    : await findEpisodeFolderUrls({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(booking.outlet.code),
        programFolderName,
        bookingFolderName,
        bookingFolderNameAlts,
        // v1.149 — AGN: last-resort match of the shared project box by projectId
        // (name drift / ops renames), mirroring the create path.
        bookingFolderCode: isAgency ? booking.projectId ?? undefined : undefined,
        // v1.112 — AGN: descend into the per-booking layer when it exists.
        bookingSubfolderName: layers.bookingSubfolderName,
        bookingSubfolderCode: booking.bookingCode,
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

  if (isAgency && resolved.viaBookingSubfolder && resolved.bookingFolderId) {
    // v1.112 — the booking has its own layer inside the project box: everything
    // in it belongs to THIS booking → scan it whole, like a non-AGN box.
    const raw = await listFilesRecursive(resolved.bookingFolderId, { maxFiles: 5000 })
    raw.filter(isFootage).forEach(f => add(f, label(f.folderPath[0] ?? '')))
  } else if (isAgency) {
    // legacy layout — shared Project box. Scan THIS booking's EP folders (root = the EP folder)…
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

  // v1.111 — GLOBAL code scan (non-AGN): ops hand-move/rename booking folders all
  // the time, which breaks the deterministic path above and footage "vanishes".
  // The Production ID in the folder name is immutable — sweep every code-bearing
  // folder anywhere the service account can see, and aggregate files from the
  // ones the deterministic pass didn't already cover. Landing/staging/photo trees
  // are included on purpose: "ตรวจหา footage" should show files wherever they sit,
  // labeled by which folder they're in.
  // v1.112 — AGN included: the per-booking layer's name embeds the booking code,
  // so the global sweep finds it (and the landing/staging trees) like any outlet.
  let extraBoxUrl: string | null = null
  if (booking.bookingCode) {
    try {
      const candidates = await findFoldersByCode(booking.bookingCode)
      const seenRoots = new Set([resolved.bookingFolderId].filter(Boolean) as string[])
      // v1.113.3 — walk candidates in PARALLEL (each is its own tree; the
      // sequential walk stacked multi-tree latencies past the 60s proxy).
      const fresh = candidates.filter(c => {
        if (seenRoots.has(c.id)) return false
        seenRoots.add(c.id)
        return true
      })
      const walked = await Promise.all(fresh.map(async c => ({
        c,
        files: (await listFilesRecursive(c.id, { maxFiles: 5000 })).filter(isFootage),
      })))
      for (const { c, files } of walked) {
        if (files.length === 0) continue
        // Dedup vs the deterministic pass by top-folder id (add() keys on it) —
        // nested/duplicate candidates can't double-count a folder row.
        files.forEach(f => add(f, label(c.name, f.folderPath[0] ?? '')))
        if (!extraBoxUrl) extraBoxUrl = `https://drive.google.com/drive/folders/${c.id}`
      }
    } catch (e: any) {
      console.warn('[footage] global code scan failed (non-fatal):', e?.message || e)
    }
  }

  const folders = Array.from(folderMap.values()).sort((a, b) => a.label.localeCompare(b.label))
  const fileCount = folders.reduce((n, f) => n + f.fileCount, 0)
  // Prefer the canonical box link; fall back to wherever the code scan found files.
  return { folders, fileCount, bookingFolderUrl: resolved.bookingFolderUrl || extraBoxUrl }
}

// ── Cached detect payload (v1.111) ──────────────────────────────────────────
// The full "detect footage" payload = the resolved folders PLUS the sound-staging
// link. Both the upload panel (every open) and notify-ready (preview + send) used
// to recompute this recursive Drive walk each time — very slow for big shoots. We
// now cache it on the booking (footageCache / footageCacheAt) and only re-walk on
// an explicit refresh or after footage changes (upload / merge invalidate it).

export interface FootagePayload {
  found: number
  fileCount: number
  folders: FootageFolder[]
  bookingFolderUrl: string | null
  soundStagingUrl: string | null
}

export interface BookingForFootagePayload extends BookingForFootage {
  id: string
  crewRequired?: string[] | null
}

/** Fresh (uncached) full payload: folders + sound-staging link. */
export async function computeFootagePayload(booking: BookingForFootagePayload): Promise<FootagePayload> {
  const { folders, fileCount, bookingFolderUrl } = await resolveFootageFolders(booking)
  let soundStagingUrl: string | null = null
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (root && booking.bookingCode && bookingNeedsSound(booking.crewRequired)) {
    const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
    if (stagingRoot) {
      // match by Production ID (folder may be legacy "<code> · …" or "<show> · … (<code>)").
      const id = await findSoundStagingFolderByCode(stagingRoot, booking.bookingCode)
      if (id) soundStagingUrl = `https://drive.google.com/drive/folders/${id}`
    }
  }
  return { found: folders.length, fileCount, folders, bookingFolderUrl, soundStagingUrl }
}

export interface CachedFootagePayload extends FootagePayload { cached: boolean; cachedAt: string | null }

/**
 * Return the cached payload if present (and not force-refreshed), else compute it
 * fresh and store it. Cache is valid iff footageCacheAt is set — invalidating is a
 * cheap `footageCacheAt = null` write (see clearFootageCache), no need to null the
 * JSON blob itself.
 */
export async function getCachedFootagePayload(booking: BookingForFootagePayload, opts: { refresh?: boolean } = {}): Promise<CachedFootagePayload> {
  if (!opts.refresh) {
    const row = await prisma.booking.findUnique({ where: { id: booking.id }, select: { footageCache: true, footageCacheAt: true } })
    const c = row?.footageCache as unknown as Partial<FootagePayload> | null | undefined
    // Only trust a cache that's fully shaped — a partial/corrupt blob falls through
    // to a fresh recompute rather than leaking undefined fields to callers.
    if (row?.footageCacheAt && c && Array.isArray(c.folders) && typeof c.found === 'number' && typeof c.fileCount === 'number') {
      return {
        found: c.found,
        fileCount: c.fileCount,
        folders: c.folders,
        // Coerce URL fields to string|null (a corrupt blob could hold an
        // array/object; `?? null` wouldn't catch that → would render "[object Object]").
        bookingFolderUrl: typeof c.bookingFolderUrl === 'string' ? c.bookingFolderUrl : null,
        soundStagingUrl: typeof c.soundStagingUrl === 'string' ? c.soundStagingUrl : null,
        cached: true,
        cachedAt: row.footageCacheAt.toISOString(),
      }
    }
  }
  const fresh = await computeFootagePayload(booking)
  const now = new Date()
  await prisma.booking.update({ where: { id: booking.id }, data: { footageCache: fresh as any, footageCacheAt: now } }).catch(() => {})
  return { ...fresh, cached: false, cachedAt: now.toISOString() }
}

/** Invalidate the cache (footage changed) — next detect re-walks Drive. */
export async function clearFootageCache(bookingId: string): Promise<void> {
  // Log (don't silently swallow) so a failed invalidation that would leave a
  // stale cache is at least visible; notify-ready also re-checks fresh on empty.
  await prisma.booking.update({ where: { id: bookingId }, data: { footageCacheAt: null } })
    .catch((e: any) => console.warn('[footage] clearFootageCache failed for', bookingId, e?.message || e))
}
