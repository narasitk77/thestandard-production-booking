/**
 * v1.108 — "sound-merge" routine. The Sound team drops audio DIRECT into a staging
 * tree (`<FOOTAGE_ROOT>/_SOUND-STAGING/<Production ID · job>/`) that lives OUTSIDE
 * the video project folder, so the videographer's wholesale folder overwrite
 * (HDD → Production Team mirror) can never delete it. This worker then COPIES the
 * staged audio into the video box's `AUDIO/` folder, keyed by Production ID, so the
 * final box bundles video + sound.
 *
 * - Idempotent: skips files already in the box AUDIO (matched by name + size).
 * - Self-healing: if the box is later re-overwritten, the next run re-copies
 *   (staging is the durable master; copy, never move).
 * - Read-only on the box until there ARE new files to add (then ensures AUDIO).
 */
import { prisma } from '@/lib/db'
import {
  findChildFolder, copyFileToFolder, listFilesRecursive, findEpisodeFolderUrls,
  ensureFolderPath, hasDriveCredentials, SOUND_STAGING_DIR, listSoundStagingBookingFolders,
} from '@/lib/google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, legacyBookingFolderName, folderNameMatchesCode, bookingNeedsSound,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
// v1.114 — id-first: trust stored folder IDs before any name matching.
import { getDriveLink, rememberDriveLinks } from '@/lib/drive-links'
import { isFolderAlive } from '@/lib/google-drive'

export interface SoundMergeResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  bookings: number   // Sound bookings considered
  staged: number     // audio files seen in staging
  merged: number     // files copied into a box (or would-copy in dryRun)
  errors: number
  results: Array<{ bookingCode: string | null; staged?: number; copied?: number; skipped?: string; error?: string }>
}

// `_SHOOT.txt` / `_SHOOT-<id>.txt` are booking-info files, not footage.
const isAudio = (name: string) => !/^_SHOOT\b.*\.txt$/i.test(name)

export async function runSoundMerge(opts: { dryRun?: boolean; onlyCode?: string } = {}): Promise<SoundMergeResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, staged: 0, merged: 0, errors: 0, results: [] as SoundMergeResult['results'] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', ...base }

  // The staging tree only exists once a Sound booking has been approved. No tree → nothing to do.
  const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
  if (!stagingRoot) return { skipped: true, reason: 'no _SOUND-STAGING tree yet', ...base }
  // List the staging folders ONCE and match each booking by the IMMUTABLE
  // Production-ID prefix — not the full name, which embeds the (editable) job
  // title. v1.123: spans flat + show-category nested shapes.
  const stagingChildren = await listSoundStagingBookingFolders(stagingRoot)

  // Bound to recent shoots: the self-heal (re-copy after a box re-overwrite) only
  // matters while a shoot is actively being uploaded, so old jobs needn't be
  // re-scanned every hour (keeps per-run Drive calls bounded as the roster grows).
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) // 45 days
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, deletedAt: null, bookingCode: { not: null }, shootDate: { gte: since } },
    select: {
      id: true, driveFolders: true,
      bookingCode: true, projectId: true, projectName: true, category: true, crewRequired: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } } },
    },
  })

  for (const b of bookings) {
    if (!b.bookingCode || !bookingNeedsSound(b.crewRequired)) continue
    if (opts.onlyCode && b.bookingCode.toUpperCase() !== opts.onlyCode.toUpperCase()) continue
    base.bookings++
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
    const bookingFolderName = buildBookingFolderName(b.bookingCode, jobName, showName)
    try {
      // v1.110 — match by immutable Production ID, tolerating both the legacy
      // "<code> · …" and the new "<show> · … (<code>)" folder shapes.
      const code = b.bookingCode
      const stagingLink = getDriveLink(b.driveFolders, 'staging')
      let stagingId: string | null = stagingLink && await isFolderAlive(stagingLink) ? stagingLink : null
      if (!stagingId) stagingId = stagingChildren.find(c => folderNameMatchesCode(c.name, code))?.id ?? null
      if (!stagingId) { base.results.push({ bookingCode: b.bookingCode, skipped: 'no staging folder' }); continue }
      const stagingFiles = (await listFilesRecursive(stagingId, { maxFiles: 2000 })).filter(f => isAudio(f.name))
      base.staged += stagingFiles.length
      if (stagingFiles.length === 0) { base.results.push({ bookingCode: b.bookingCode, staged: 0 }); continue }

      // Resolve the video box (read-only). If it hasn't landed yet → skip (try next run).
      // v1.112 — AGN merges too: AUDIO goes inside the per-booking layer of the
      // project box, so bookings' audio can't mix anymore.
      let boxTargetId: string | null = null
      const boxLink = getDriveLink(b.driveFolders, 'box')
      if (boxLink && await isFolderAlive(boxLink)) boxTargetId = boxLink
      if (!boxTargetId) {
        const layers = shootFolderLayers({
          outletCode: b.outlet.code,
          showName,
          category: b.category, projectId: b.projectId, projectName: b.projectName,
          bookingCode: b.bookingCode, jobName,
        })
        const isAgency = b.outlet.code === 'AGN'
        const resolved = await findEpisodeFolderUrls({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(b.outlet.code),
          programFolderName: layers.programFolderName,
          bookingFolderName: layers.bookingSubfolderName ? layers.bookingFolderName : bookingFolderName,
          bookingFolderNameAlts: layers.bookingSubfolderName ? [] : [legacyBookingFolderName(b.bookingCode, jobName)], // pre-v1.110 box
          bookingCode: code, // v1.113.6 — last-resort box match by Production ID
          bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: code,
          episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency })),
        })
        if (!resolved.bookingFolderId) { base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, skipped: 'box not found (video not landed yet)' }); continue }
        boxTargetId = resolved.bookingFolderId
        if (layers.bookingSubfolderName && !resolved.viaBookingSubfolder && !opts.dryRun) {
          boxTargetId = await ensureFolderPath(resolved.bookingFolderId, [layers.bookingSubfolderName])
        }
      }
      if (!opts.dryRun) await rememberDriveLinks((b as any).id, { staging: stagingId, box: boxTargetId })

      // Dedup against the box's AUDIO folder (by name + size). May not exist yet.
      const existingAudio = await findChildFolder(boxTargetId, 'AUDIO')
      const have = new Set(existingAudio ? (await listFilesRecursive(existingAudio, { maxFiles: 2000 })).map(f => `${f.name}|${f.size ?? ''}`) : [])
      const toCopy = stagingFiles.filter(f => !have.has(`${f.name}|${f.size ?? ''}`))

      if (opts.dryRun) { base.merged += toCopy.length; base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, copied: toCopy.length }); continue }
      if (toCopy.length === 0) { base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, copied: 0 }); continue }

      const audioId = existingAudio || await ensureFolderPath(boxTargetId, ['AUDIO'])
      let copied = 0
      for (const f of toCopy) {
        try { await copyFileToFolder(f.id, audioId, f.name); copied++ }
        catch (e: any) { base.errors++; console.error('[sound-merge] copy failed:', b.bookingCode, f.name, e?.message || e) }
      }
      base.merged += copied
      base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, copied })
    } catch (e: any) {
      base.errors++
      base.results.push({ bookingCode: b.bookingCode, error: e?.message || String(e) })
    }
  }

  return { skipped: false, ...base }
}

// ── Per-booking variant (v1.111) ────────────────────────────────────────────
// Fold ONE booking's staged audio into its box AUDIO folder — the fast, scoped
// counterpart of runSoundMerge, for the upload page's per-booking merge button.

export interface SoundMergeBooking {
  id?: string
  driveFolders?: unknown
  bookingCode: string | null
  projectId: string | null
  projectName: string | null
  category: string | null
  crewRequired: string[] | null
  outlet: { code: string }
  program: { name: string }
  episodes: Array<{ episodeId: string; sequence: number; title: string; program: { name: string } | null }>
}

export interface BookingSoundMergeResult {
  skipped?: boolean
  reason?: string
  staged: number
  copied: number
  err: number
  boxFolderUrl?: string | null
}

/** COPY this ONE booking's staged audio into its box AUDIO folder (dedup by name+size). */
export async function mergeBookingSound(b: SoundMergeBooking, opts: { dryRun?: boolean } = {}): Promise<BookingSoundMergeResult> {
  const dryRun = !!opts.dryRun
  const zero = { staged: 0, copied: 0, err: 0 }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'ยังไม่ได้ตั้งค่า Drive', ...zero }
  const code = b.bookingCode
  if (!code) return { skipped: true, reason: 'ไม่มี Production ID', ...zero }
  if (!bookingNeedsSound(b.crewRequired)) return { skipped: true, reason: 'งานนี้ไม่มีทีมเสียง', ...zero }
  const stagingLink = getDriveLink(b.driveFolders, 'staging')
  let stagingId: string | null = stagingLink && await isFolderAlive(stagingLink) ? stagingLink : null
  if (!stagingId) {
    const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
    if (!stagingRoot) return { skipped: true, reason: 'ยังไม่มี _SOUND-STAGING', ...zero }
    const stagingChildren = await listSoundStagingBookingFolders(stagingRoot)
    stagingId = stagingChildren.find(c => folderNameMatchesCode(c.name, code))?.id ?? null
  }
  if (!stagingId) return { skipped: true, reason: 'ยังไม่มีโฟลเดอร์เสียงใน staging', ...zero }
  const stagingFiles = (await listFilesRecursive(stagingId, { maxFiles: 2000 })).filter(f => isAudio(f.name))
  if (stagingFiles.length === 0) return { ...zero }

  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
  let boxTargetId: string | null = null
  const boxLink = getDriveLink(b.driveFolders, 'box')
  if (boxLink && await isFolderAlive(boxLink)) boxTargetId = boxLink
  if (!boxTargetId) {
    // v1.112 — AGN merges too (AUDIO inside the per-booking layer of the project box).
    const isAgency = b.outlet.code === 'AGN'
    const layers = shootFolderLayers({
      outletCode: b.outlet.code, showName, category: b.category,
      projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
    })
    const resolved = await findEpisodeFolderUrls({
      rootFolderId: root,
      outletCanonicalName: outletDriveFolderName(b.outlet.code),
      programFolderName: layers.programFolderName,
      bookingFolderName: layers.bookingFolderName,
      bookingFolderNameAlts: layers.bookingSubfolderName ? [] : [legacyBookingFolderName(code, jobName)],
      bookingCode: code, // v1.113.6 — last-resort box match by Production ID
      bookingSubfolderName: layers.bookingSubfolderName,
      bookingSubfolderCode: code,
      episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency })),
    })
    if (!resolved.bookingFolderId) return { skipped: true, reason: 'ยังไม่พบกล่อง (วิดีโอยังไม่ลง?)', staged: stagingFiles.length, copied: 0, err: 0 }
    boxTargetId = resolved.bookingFolderId
    if (layers.bookingSubfolderName && !resolved.viaBookingSubfolder && !dryRun) {
      boxTargetId = await ensureFolderPath(resolved.bookingFolderId, [layers.bookingSubfolderName])
    }
  }
  if (!dryRun && b.id) await rememberDriveLinks(b.id, { staging: stagingId, box: boxTargetId })

  const existingAudio = await findChildFolder(boxTargetId, 'AUDIO')
  const have = new Set(existingAudio ? (await listFilesRecursive(existingAudio, { maxFiles: 2000 })).map(f => `${f.name}|${f.size ?? ''}`) : [])
  const toCopy = stagingFiles.filter(f => !have.has(`${f.name}|${f.size ?? ''}`))
  const boxUrl = boxTargetId ? `https://drive.google.com/drive/folders/${boxTargetId}` : null
  if (dryRun) return { staged: stagingFiles.length, copied: toCopy.length, err: 0, boxFolderUrl: boxUrl }
  if (toCopy.length === 0) return { staged: stagingFiles.length, copied: 0, err: 0, boxFolderUrl: boxUrl }

  const audioId = existingAudio || await ensureFolderPath(boxTargetId, ['AUDIO'])
  let copied = 0, err = 0
  for (const f of toCopy) {
    try { await copyFileToFolder(f.id, audioId, f.name); copied++ }
    catch (e: any) { err++; console.error('[sound-merge] copy failed:', code, f.name, e?.message || e) }
  }
  return { staged: stagingFiles.length, copied, err, boxFolderUrl: boxUrl }
}
