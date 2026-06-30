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
  findChildFolder, listChildFolders, copyFileToFolder, listFilesRecursive, findEpisodeFolderUrls,
  ensureFolderPath, hasDriveCredentials, SOUND_STAGING_DIR,
} from '@/lib/google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, bookingNeedsSound,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'

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

export async function runSoundMerge(opts: { dryRun?: boolean } = {}): Promise<SoundMergeResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, staged: 0, merged: 0, errors: 0, results: [] as SoundMergeResult['results'] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', ...base }

  // The staging tree only exists once a Sound booking has been approved. No tree → nothing to do.
  const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
  if (!stagingRoot) return { skipped: true, reason: 'no _SOUND-STAGING tree yet', ...base }
  // List the staging folders ONCE (one Drive call) and match each booking to its
  // folder by the IMMUTABLE Production-ID prefix — not the full name, which embeds
  // the (editable) job/episode title and would drift after a post-approval rename.
  const stagingChildren = await listChildFolders(stagingRoot)

  // Bound to recent shoots: the self-heal (re-copy after a box re-overwrite) only
  // matters while a shoot is actively being uploaded, so old jobs needn't be
  // re-scanned every hour (keeps per-run Drive calls bounded as the roster grows).
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) // 45 days
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, deletedAt: null, bookingCode: { not: null }, shootDate: { gte: since } },
    select: {
      bookingCode: true, projectId: true, projectName: true, category: true, crewRequired: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } } },
    },
  })

  for (const b of bookings) {
    if (!b.bookingCode || !bookingNeedsSound(b.crewRequired)) continue
    base.bookings++
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    const bookingFolderName = buildBookingFolderName(b.bookingCode, jobName)
    try {
      // AGN shares ONE project box across bookings → a box-level AUDIO would mix
      // bookings' audio. Skip AGN for now (staging still kept; merge deferred).
      if (b.outlet.code === 'AGN') { base.results.push({ bookingCode: b.bookingCode, skipped: 'AGN project box shared — merge skipped' }); continue }

      // Match by immutable Production-ID prefix (folder name is "<code> · <job>" or "<code>").
      const code = b.bookingCode
      const stagingId = stagingChildren.find(c => c.name === code || c.name.startsWith(code + ' '))?.id ?? null
      if (!stagingId) { base.results.push({ bookingCode: b.bookingCode, skipped: 'no staging folder' }); continue }
      const stagingFiles = (await listFilesRecursive(stagingId, { maxFiles: 2000 })).filter(f => isAudio(f.name))
      base.staged += stagingFiles.length
      if (stagingFiles.length === 0) { base.results.push({ bookingCode: b.bookingCode, staged: 0 }); continue }

      // Resolve the video box (read-only). If it hasn't landed yet → skip (try next run).
      const { programFolderName } = shootFolderLayers({
        outletCode: b.outlet.code,
        showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
        category: b.category, projectId: b.projectId, projectName: b.projectName,
        bookingCode: b.bookingCode, jobName,
      })
      const resolved = await findEpisodeFolderUrls({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(b.outlet.code),
        programFolderName, bookingFolderName,
        episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, {})),
      })
      if (!resolved.bookingFolderId) { base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, skipped: 'box not found (video not landed yet)' }); continue }

      // Dedup against the box's AUDIO folder (by name + size). May not exist yet.
      const existingAudio = await findChildFolder(resolved.bookingFolderId, 'AUDIO')
      const have = new Set(existingAudio ? (await listFilesRecursive(existingAudio, { maxFiles: 2000 })).map(f => `${f.name}|${f.size ?? ''}`) : [])
      const toCopy = stagingFiles.filter(f => !have.has(`${f.name}|${f.size ?? ''}`))

      if (opts.dryRun) { base.merged += toCopy.length; base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, copied: toCopy.length }); continue }
      if (toCopy.length === 0) { base.results.push({ bookingCode: b.bookingCode, staged: stagingFiles.length, copied: 0 }); continue }

      const audioId = existingAudio || await ensureFolderPath(resolved.bookingFolderId, ['AUDIO'])
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
