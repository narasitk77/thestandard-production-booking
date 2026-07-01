/**
 * v1.109 — "video-merge" routine. The NAS mirrors each shoot's footage into a
 * FLAT landing folder on the "Production Team" Shared Drive
 * (`<PRODUCTION_TEAM_ROOT>/<Production ID · job>/<[EP]/camera>/…`). This routine
 * MOVES that footage into the proper VIDEO 2026 box
 * (`<FOOTAGE_ROOT>/<outlet>/<program>/<Production ID · job>/<[EP]/camera>/`),
 * mirroring the flat subfolder tree so cameras/EPs land in the right place.
 *
 * MOVE (not copy): each file is relocated atomically via addParents/removeParents
 * (google-drive.moveFileToFolder) — fast even for large video, and on failure the
 * file stays in the landing folder (no data loss). Naturally idempotent + resumable:
 * a moved file is gone from the landing tree, so a re-run only handles the remainder.
 *
 * - Skips a file already present in the box (same name + size) — leaves it in the
 *   landing folder for manual review rather than creating a duplicate.
 * - AGN is skipped: its box is a shared Project folder (per-EP keyed), so a flat
 *   per-booking merge would misplace footage.
 * - Bounded to recent shoots (45 days) to keep per-run Drive calls bounded.
 */
import { prisma } from './db'
import {
  findChildFolder, listChildFolders, listFilesInFolder, moveFileToFolder,
  findEpisodeFolderUrls, ensureFolderPath, hasDriveCredentials,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, legacyBookingFolderName, folderNameMatchesCode,
} from './outlet-folders'
import { bookingShowName } from './display'

// "Production Team" landing Shared Drive (NAS drop zone) — mirrors prep-folders.ts.
const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

// `_SHOOT.txt` / `_SHOOT-<id>.txt` are booking-info files, present in both trees — never move them.
const isShootInfo = (name: string) => /^_SHOOT\b.*\.txt$/i.test(name)

export interface VideoMergeResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  bookings: number   // bookings considered
  landed: number     // footage files seen in landing folders
  moved: number      // files moved into a box (or would-move in dryRun)
  errors: number
  results: Array<{ bookingCode: string | null; seen?: number; moved?: number; dup?: number; err?: number; skipped?: string }>
}

type Stats = { seen: number; moved: number; dup: number; err: number }

/**
 * Recursively mirror-MOVE files from a landing subtree into the matching box
 * subtree. `destId` is null only in a dryRun where the box subfolder doesn't
 * exist yet (then dedup is skipped and everything counts as would-move).
 */
export async function mirrorMove(srcId: string, destId: string | null, code: string, stats: Stats, dryRun: boolean): Promise<void> {
  const files = (await listFilesInFolder(srcId)).filter(f => !isShootInfo(f.name))
  if (files.length) {
    const have = destId
      ? new Set((await listFilesInFolder(destId)).map(f => `${f.name}|${f.size ?? ''}`))
      : new Set<string>()
    for (const f of files) {
      stats.seen++
      if (have.has(`${f.name}|${f.size ?? ''}`)) { stats.dup++; continue } // already in box — leave in landing
      if (dryRun || !destId) { stats.moved++; continue }
      try { await moveFileToFolder(f.id, destId, srcId); stats.moved++ }
      catch (e: any) { stats.err++; console.error('[video-merge] move failed:', code, f.name, e?.message || e) }
    }
  }
  // Recurse into subfolders, mirroring each into the box (camera / EP layers).
  const subs = await listChildFolders(srcId)
  for (const s of subs) {
    let destSub: string | null = destId ? await findChildFolder(destId, s.name) : null
    if (!destSub && destId && !dryRun) destSub = await ensureFolderPath(destId, [s.name])
    await mirrorMove(s.id, destSub, code, stats, dryRun)
  }
}

export async function runVideoMerge(opts: { dryRun?: boolean } = {}): Promise<VideoMergeResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, landed: 0, moved: 0, errors: 0, results: [] as VideoMergeResult['results'] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', ...base }

  // List the landing folders ONCE and match each booking by its immutable
  // Production-ID prefix (the folder name embeds the editable job title).
  const flatChildren = await listChildFolders(PRODUCTION_TEAM_ROOT)
  if (flatChildren.length === 0) return { skipped: true, reason: 'Production Team landing empty / inaccessible', ...base }

  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) // 45 days
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, deletedAt: null, bookingCode: { not: null }, shootDate: { gte: since } },
    select: {
      bookingCode: true, projectId: true, projectName: true, category: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } } },
    },
  })

  for (const b of bookings) {
    if (!b.bookingCode) continue
    base.bookings++
    const code = b.bookingCode
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
    try {
      // AGN shares ONE project box across bookings (per-EP keyed) → a flat
      // per-booking merge would misplace footage. Skip (landing kept).
      if (b.outlet.code === 'AGN') { base.results.push({ bookingCode: code, skipped: 'AGN project box shared — merge skipped' }); continue }

      // v1.110 — match the landing folder by Production ID (legacy "<code> · …" OR
      // new "<show> · … (<code>)" shape).
      const flatId = flatChildren.find(c => folderNameMatchesCode(c.name, code))?.id ?? null
      if (!flatId) { base.results.push({ bookingCode: code, skipped: 'no landing folder' }); continue }

      // Resolve the box (read-only). If it hasn't landed yet → skip (try next run).
      const { programFolderName } = shootFolderLayers({
        outletCode: b.outlet.code,
        showName,
        category: b.category, projectId: b.projectId, projectName: b.projectName,
        bookingCode: code, jobName,
      })
      const resolved = await findEpisodeFolderUrls({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(b.outlet.code),
        programFolderName,
        bookingFolderName: buildBookingFolderName(code, jobName, showName),
        bookingFolderNameAlts: [legacyBookingFolderName(code, jobName)], // pre-v1.110 box
        episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, {})),
      })
      if (!resolved.bookingFolderId) { base.results.push({ bookingCode: code, skipped: 'box not found (not prepped yet)' }); continue }

      const stats: Stats = { seen: 0, moved: 0, dup: 0, err: 0 }
      await mirrorMove(flatId, resolved.bookingFolderId, code, stats, !!opts.dryRun)
      base.landed += stats.seen; base.moved += stats.moved; base.errors += stats.err
      base.results.push({ bookingCode: code, seen: stats.seen, moved: stats.moved, dup: stats.dup, err: stats.err })
    } catch (e: any) {
      base.errors++
      base.results.push({ bookingCode: code, skipped: `error: ${e?.message || String(e)}` })
    }
  }

  return { skipped: false, ...base }
}

// ── Per-booking variant (v1.111) ────────────────────────────────────────────
// The upload page needs to merge ONE booking fast (the system-wide runVideoMerge
// walks ~110 bookings and blows past the 60s reverse-proxy timeout, so the UI
// reported failure even though the user only cared about one job). Same logic as
// the loop body above, scoped to a single booking.

export interface VideoMergeBooking {
  bookingCode: string | null
  projectId: string | null
  projectName: string | null
  category: string | null
  outlet: { code: string }
  program: { name: string }
  episodes: Array<{ episodeId: string; sequence: number; title: string; program: { name: string } | null }>
}

export interface BookingVideoMergeResult {
  skipped?: boolean
  reason?: string
  seen: number
  moved: number
  dup: number
  err: number
  boxFolderUrl?: string | null
}

/** MOVE this ONE booking's NAS landing footage into its VIDEO 2026 box. */
export async function mergeBookingVideo(b: VideoMergeBooking, opts: { dryRun?: boolean } = {}): Promise<BookingVideoMergeResult> {
  const dryRun = !!opts.dryRun
  const zero = { seen: 0, moved: 0, dup: 0, err: 0 }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'ยังไม่ได้ตั้งค่า Drive', ...zero }
  const code = b.bookingCode
  if (!code) return { skipped: true, reason: 'ไม่มี Production ID', ...zero }
  if (b.outlet.code === 'AGN') return { skipped: true, reason: 'AGN ใช้กล่องโปรเจกต์ร่วมกัน — ข้ามการรวมวิดีโอ', ...zero }

  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })

  const flatChildren = await listChildFolders(PRODUCTION_TEAM_ROOT)
  const flatId = flatChildren.find(c => folderNameMatchesCode(c.name, code))?.id ?? null
  if (!flatId) return { skipped: true, reason: 'ยังไม่มีโฟลเดอร์ใน Production Team (NAS ยังไม่ sync?)', ...zero }

  const { programFolderName } = shootFolderLayers({
    outletCode: b.outlet.code, showName, category: b.category,
    projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
  })
  const resolved = await findEpisodeFolderUrls({
    rootFolderId: root,
    outletCanonicalName: outletDriveFolderName(b.outlet.code),
    programFolderName,
    bookingFolderName: buildBookingFolderName(code, jobName, showName),
    bookingFolderNameAlts: [legacyBookingFolderName(code, jobName)],
    episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, {})),
  })
  if (!resolved.bookingFolderId) return { skipped: true, reason: 'ยังไม่พบกล่อง Video 2026 (ยังไม่ถูก prep?)', ...zero }

  const stats: Stats = { seen: 0, moved: 0, dup: 0, err: 0 }
  await mirrorMove(flatId, resolved.bookingFolderId, code, stats, dryRun)
  return { ...stats, boxFolderUrl: resolved.bookingFolderUrl ?? null }
}
