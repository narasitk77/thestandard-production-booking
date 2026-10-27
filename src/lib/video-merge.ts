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
 * - v1.112 — AGN merges into the per-booking layer INSIDE its shared project box
 *   ("<job> (<code>)"), created on demand; no more misplacement, no more skip.
 * - Bounded to recent shoots (45 days) to keep per-run Drive calls bounded.
 * - v1.127 — FAST PATH: a landing subfolder whose box twin is absent (or is an
 *   empty prep skeleton, which gets trashed and swapped out) is relocated as a
 *   WHOLE folder — one files.update for the entire subtree instead of one per
 *   file. Confirmed working across our two Shared Drives by a live test
 *   (2026-07-07), even though Google's docs still say folder moves across
 *   shared drives are unsupported — so every folder move falls back to the
 *   per-file mirror on any error. After a clean move, the emptied landing
 *   shell (only _SHOOT stubs / empty folders left) is trashed (recoverable).
 */
import { prisma } from './db'
import {
  findChildFolder, listChildFolders, listFilesInFolder, moveFileToFolder,
  findEpisodeFolderUrls, ensureFolderPath, hasDriveCredentials,
  isFolderEmpty, trashDriveItem,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, episodeLeadUsesId, buildBookingFolderName, legacyBookingFolderName, folderNameMatchesCode,
} from './outlet-folders'
import { bookingShowName } from './display'
// v1.114 — id-first: trust stored folder IDs before any name matching.
import { getDriveLink, rememberDriveLinks } from './drive-links'
import { noteResolve } from './id-first-metrics'
import { isFolderAlive } from './google-drive'
import { alertOps, OPS_ALERT_EVERY_MS } from './ops-alert'
import { tryLockMerge, unlockMerge, videoMergeKey } from './merge-lock'
import { createHash } from 'crypto'

// "Production Team" landing Shared Drive (NAS drop zone) — mirrors prep-folders.ts.
const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

// `_SHOOT.txt` / `_SHOOT-<id>.txt` are booking-info files, present in both trees — never move them.
const isShootInfo = (name: string) => /^_SHOOT\b.*\.txt$/i.test(name)

export interface VideoMergeResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  bookings: number      // bookings considered
  landed: number        // footage files seen in landing folders (fast-path folders are NOT listed, so not counted here)
  moved: number         // files moved into a box (or would-move in dryRun)
  movedFolders: number  // v1.127 — whole subfolders relocated in one call (contents uncounted)
  errors: number
  results: Array<{ bookingCode: string | null; seen?: number; moved?: number; movedFolders?: number; dup?: number; err?: number; conflicts?: number; skipped?: string }>
}

type Stats = { seen: number; moved: number; movedFolders: number; dup: number; err: number; conflicts: string[] }

/**
 * v1.261 — sync-storm guard. Two uploaders (NAS Cloud Sync + a crew member's Google
 * Drive for desktop) pushing the same NAS folder into the landing drive create a
 * same-name twin, then rename-fight forever: `XDROOT (1) (1) (1)…`, `Thmbnl (2) (1)…`,
 * `A032C001_261006UM (1).MXF`. On 2026-10-05 the hourly merge fast-path-moved such a
 * subtree WHOLE into NWS-KYM-261005-01's box (40 shells + a duplicate 28 GB MXF).
 * Anything carrying the suffix — or any subtree containing one — stays in landing
 * and is reported, so a human (or the storm ending) sorts it out before it lands.
 */
export const isConflictName = (name: string) => /(?: \(\d+\))+(?=(?:\.[^.]*)?$)/.test(name)

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
      if (isConflictName(f.name)) { stats.conflicts.push(f.name); continue } // v1.261 — sync-storm leftover, never land it
      if (have.has(`${f.name}|${f.size ?? ''}`)) { stats.dup++; continue } // already in box — leave in landing
      if (dryRun || !destId) { stats.moved++; continue }
      try { await moveFileToFolder(f.id, destId, srcId); stats.moved++ }
      catch (e: any) { stats.err++; console.error('[video-merge] move failed:', code, f.name, e?.message || e) }
    }
  }
  // Subfolders (camera / EP layers). v1.127 fast path: when the box has no
  // same-name twin — or only an EMPTY prep-skeleton twin, which we trash first
  // so the incoming folder takes its place — relocate the WHOLE subtree in one
  // files.update. Per-file dedup is vacuous in both cases (dest has no files),
  // so semantics match the old mirror. Any refusal (e.g. Google re-blocking
  // cross-drive folder moves) falls back to the per-file mirror unchanged.
  const subs = await listChildFolders(srcId)
  for (const s of subs) {
    // v1.150.2 — NEVER relocate an EMPTY landing subtree. The nightly lifecycle
    // creates tomorrow's drop skeleton (EP / CAM-A..N / AUDIO) at 19:00 BKK;
    // the hourly merge then found "box twin missing or empty" and moved that
    // fresh, still-empty skeleton into the box — trashing the box's own twin
    // first. Net effect every night: the crew's drop folder went back to empty
    // and there were no CAM slots to drop into the next morning (reported
    // 2026-07-22, verified on AGN-260722-01: its EP+CAM-A+CAM-B created 19:00
    // were re-parented under the VIDEO 2026 box within the hour).
    // An empty subtree has nothing to merge, so skipping it is a pure no-op for
    // the merge and keeps the drop target intact.
    // v1.261 — sync-storm guard: a conflict-named folder never moves; a clean folder
    // that CONTAINS conflict names loses the whole-folder fast path and is mirrored
    // per file instead, so the clean footage inside still lands while every
    // "(1)" item is caught (and counted) at its own level and stays in landing.
    if (isConflictName(s.name)) { stats.conflicts.push(s.name); continue }
    if (await isLandingShell(s.id)) continue
    let destSub: string | null = destId ? await findTwinFolder(destId, s.name) : null
    if (destId && !dryRun) {
      // v1.261.1 — only the whole-folder fast path (box twin absent or an empty
      // skeleton) needs to know the subtree is storm-free, so only walk it then.
      // v1.261 walked every branch of each subtree at EVERY level of this
      // recursion (v1.260's shell check follows one path to the first file):
      // the hourly run went from ~6 min to 33–52 min and the worker gave up at
      // its 30-min idle timeout on every run from 6 Oct 17:04 BKK on. The
      // per-file path below catches conflict names at their own level anyway.
      const twinEmpty = !!destSub && await isFolderEmpty(destSub)
      if ((!destSub || twinEmpty) && !(await hasConflictInside(s.id))) {
        // hasConflictInside can take a while — re-check the twin is STILL empty
        // right before trashing it (something may have landed meanwhile).
        if (destSub && await isFolderEmpty(destSub)) {
          // trash-BEFORE-move: if the trash fails we still have the twin and just
          // mirror into it; move-before-trash could leave two same-name folders.
          try { await trashDriveItem(destSub); destSub = null } catch { /* keep twin, mirror into it */ }
        }
        if (!destSub) {
          try { await moveFileToFolder(s.id, destId, srcId); stats.movedFolders++; continue }
          catch (e: any) { console.warn('[video-merge] folder move → per-file fallback:', code, s.name, e?.message || e) }
        }
      }
      if (!destSub) destSub = await ensureFolderPath(destId, [s.name])
    }
    await mirrorMove(s.id, destSub, code, stats, dryRun)
  }
}

/**
 * v1.151.3 — find the box's counterpart of a landing subfolder.
 *
 * Exact name first, then — for an EP layer — the IMMUTABLE lead segment
 * ("EP01" / a project EP id), the same key ensureEpisodeFolder and
 * findEpisodeFolderUrls match on.
 *
 * Why this matters: the two trees deliberately name the EP layer differently.
 * The box uses buildEpisodeFolderName ("EP01 · <episode title>") while the
 * landing folder is built from the crew-facing display name, which routinely
 * carries the van/contact note ("EP01 · … (รถ. 22. ก.ค …)"). Exact-name
 * matching therefore found NO twin for practically every booking with
 * episodes, so the whole landing EP folder was MOVED into the box beside the
 * real one — leaving that booking's footage split across two EP01 folders,
 * which is exactly the "หาไฟล์ไม่เจอ" the crew reports. Verified on
 * POP-PIV-260722-01, whose box holds both "EP01 · THE INTERVIEW …" (created
 * with the box) and "EP01 · …(รถ. 22." (moved in from landing).
 */
async function findTwinFolder(destId: string, name: string): Promise<string | null> {
  const exact = await findChildFolder(destId, name)
  if (exact) return exact
  const lead = name.split(' · ')[0]?.trim()
  // Only EP-ish leads may match loosely: a bare CAM-A/AUDIO name has no " · "
  // so `lead === name` and we must not fuzzy-match it onto something else.
  if (!lead || lead === name) return null
  const kids = await listChildFolders(destId)
  return kids.find(k => k.name === lead || k.name.startsWith(`${lead} `))?.id ?? null
}

/**
 * v1.127 — true when the landing tree holds nothing but _SHOOT stubs and empty
 * folders (i.e. everything real has moved to the box). Depth-capped; anything
 * unexpected keeps the folder. Stops at the first real file: mirrorMove calls
 * this for every subfolder at every level, so it must not walk whole trees.
 *
 * v1.261.1 — a "(1)" sync-conflict child also makes it NOT a shell, without
 * walking into it. A storm leaves hundreds of empty "XDROOT (1) (1)" shells
 * that regrow while two uploaders fight; walking them cost ~12 Drive calls each
 * per hourly run, and a folder holding only them was skipped as "empty" so the
 * storm was never reported. Now mirrorMove descends and reports them.
 */
async function isLandingShell(folderId: string, depth = 0): Promise<boolean> {
  if (depth > 4) return false
  const files = await listFilesInFolder(folderId)
  if (files.some(f => !isShootInfo(f.name))) return false
  const subs = await listChildFolders(folderId)
  if (subs.some(s => isConflictName(s.name))) return false
  for (const s of subs) {
    if (!(await isLandingShell(s.id, depth + 1))) return false
  }
  return true
}

// Real card trees reach ~7 levels below a landing subfolder
// (AVCHD: EP/CAM/card/PRIVATE/AVCHD/BDMV/BACKUP).
const CONFLICT_SCAN_DEPTH = 8

/**
 * v1.261.1 — does this landing subtree hold any sync-conflict name (see
 * isConflictName)? Stops at the first one. A tree deeper than
 * CONFLICT_SCAN_DEPTH counts as dirty: it was not fully checked, so it loses
 * the whole-folder fast path and is mirrored per file, which checks every level
 * itself. (v1.261 counted the unchecked depth as clean.)
 */
async function hasConflictInside(folderId: string, depth = 0): Promise<boolean> {
  if (depth > CONFLICT_SCAN_DEPTH) return true
  if ((await listFilesInFolder(folderId)).some(f => isConflictName(f.name))) return true
  const subs = await listChildFolders(folderId)
  if (subs.some(s => isConflictName(s.name))) return true
  for (const s of subs) if (await hasConflictInside(s.id, depth + 1)) return true
  return false
}

/*
 * v1.164 — `cleanupLandingShell` ถูกลบทิ้ง (§9 ข้อ 4, operator 2026-08-06).
 *
 * มันคือ code path เดียวใน merge ที่ "ลบ" ได้ (trash โฟลเดอร์ drop ที่ว่างแล้ว)
 * ปิดมาตั้งแต่ v1.137 เพราะทำให้โฟลเดอร์ drop ของทีมหายกลางคัน แล้วขัดกับ
 * docs/landing-folder-policy.md ที่ระบุว่า landing เป็น drop zone ถาวร
 * `VIDEO_MERGE_TRASH_LANDING` ไม่เคยถูกตั้งบน prod อีกเลย — เก็บโค้ดที่ลบได้
 * ไว้เฉย ๆ มีแต่ความเสี่ยงว่าใครจะเผลอเปิด จึงตัดออกทั้งชุดก่อนยุบเข้า reconciler
 * (สัญญาความปลอดภัย §0: reconciler ห้ามลบเกินต้นแบบ — ต้นแบบจึงต้องไม่มีอันนี้)
 */

/**
 * v1.266.2 — the same leftovers re-alerted every 6 h for days: POP-PIV-261007-02's 123 names went out 8 times
 * in 2 days (9–11 Oct 2026) while every one of its originals was already in the box — the fix is a human removing
 * one uploader, which no 6-hourly repeat makes faster. A set already reported waits a week (a backstop, so a
 * stuck leftover never goes silent for good); a set that changed — the storm is still writing — is news at the
 * normal 6 h. The last reported set is a fingerprint in system_heartbeats `sync-storm-set:<code>`.
 */
export const SYNC_STORM_SAME_SET_EVERY_MS = 7 * 24 * 3_600_000
export function conflictSetKey(names: string[]): string {
  return createHash('sha1').update([...names].sort().join('\n')).digest('hex').slice(0, 16)
}

/** v1.261 — a storm in a landing folder is an ops incident, not a counter: log + alertOps (throttle: see above). */
export async function reportConflicts(code: string, conflicts: string[]): Promise<void> {
  if (!conflicts.length) return
  const shown = conflicts.slice(0, 8).join('\n  ')
  console.warn(`[video-merge] ${code}: ${conflicts.length} sync-conflict name(s) left in landing — not merged:\n  ${shown}`)
  const set = conflictSetKey(conflicts)
  const setKey = `sync-storm-set:${code}`
  let reported: string | null = null
  try { reported = (await prisma.systemHeartbeat.findUnique({ where: { key: setKey } }))?.note ?? null }
  catch (e: any) { console.warn(`[video-merge] ${code}: อ่านชุดที่เตือนไปแล้วไม่ได้ — ถือว่าชุดใหม่:`, e?.message || e) } // louder beats silent
  const same = reported === set
  const r = await alertOps(`sync-storm:${code}`, `⚠️ โฟลเดอร์ชื่อซ้ำ "(1)" ใน landing — ${code}`,
    `video-merge ไม่ย้าย ${conflicts.length} รายการของ ${code} เพราะชื่อมีท้าย "(1)" จากซิงก์ชนกัน ` +
    `(Cloud Sync ของ NAS กับ Drive for desktop อัปโฟลเดอร์เดียวกันพร้อมกัน) — ต้องเหลือตัวอัปตัวเดียวแล้วเก็บซากก่อน ของถึงจะเข้ากล่อง\n  ${shown}${conflicts.length > 8 ? `\n  … อีก ${conflicts.length - 8}` : ''}` +
    `\n(ชุดเดิมเตือนซ้ำสัปดาห์ละครั้ง · มีชื่อใหม่เพิ่ม = เตือนใหม่)`,
    same ? SYNC_STORM_SAME_SET_EVERY_MS : OPS_ALERT_EVERY_MS)
  if (r.attempted && !same) {
    const at = new Date()
    try { await prisma.systemHeartbeat.upsert({ where: { key: setKey }, create: { key: setKey, at, note: set }, update: { at, note: set } }) }
    catch (e: any) { console.warn(`[video-merge] ${code}: บันทึกชุดที่เตือนไม่ได้ (รอบหน้าจะเตือนซ้ำที่ 6 ชม.):`, e?.message || e) }
  }
}

export async function runVideoMerge(opts: { dryRun?: boolean; onlyCode?: string } = {}): Promise<VideoMergeResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, landed: 0, moved: 0, movedFolders: 0, errors: 0, results: [] as VideoMergeResult['results'] }
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
      id: true, driveFolders: true,
      bookingCode: true, projectId: true, projectName: true, category: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } } },
    },
  })

  for (const b of bookings) {
    if (!b.bookingCode) continue
    // v1.113.5 — scoped run ("เทสกับโฟลเดอร์เดียว"): only the requested booking.
    if (opts.onlyCode && b.bookingCode.toUpperCase() !== opts.onlyCode.toUpperCase()) continue
    base.bookings++
    const code = b.bookingCode
    const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
    const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
    // v1.268.1 — the per-booking button may be merging this booking right now (merge-lock.ts).
    const lock = [videoMergeKey(b.id)]
    if (!opts.dryRun && !tryLockMerge(lock)) { base.results.push({ bookingCode: code, skipped: 'merge already running for this booking (per-booking button)' }); continue }
    try {
      const isAgency = b.outlet.code === 'AGN'

      // v1.114 — id-first: stored landing ID wins; name match is the fallback.
      const landingLink = getDriveLink(b.driveFolders, 'landing')
      let flatId: string | null = landingLink && await isFolderAlive(landingLink) ? landingLink : null
      const landingViaStored = !!flatId
      // v1.110 — match the landing folder by Production ID (legacy "<code> · …" OR
      // new "<show> · … (<code>)" shape).
      if (!flatId) {
        const byName = flatChildren.filter(c => folderNameMatchesCode(c.name, code))
        flatId = byName[0]?.id ?? null
        // v1.274 — heal at resolve time (see sound-merge): only an unambiguous match,
        // Cloud Sync "(1)" twins of a landing folder are common.
        if (byName.length === 1 && !opts.dryRun && b.id) await rememberDriveLinks(b.id, { landing: byName[0].id })
      }
      if (!flatId) { base.results.push({ bookingCode: code, skipped: 'no landing folder' }); continue }
      noteResolve('video-merge', 'landing', code, landingViaStored) // v1.154 — id-first coverage gauge

      // Resolve the box (read-only). If it hasn't landed yet → skip (try next run).
      // v1.112 — AGN merges too: the per-booking layer inside the project box is
      // the destination, so a flat merge can't misplace footage anymore.
      // v1.114 — id-first: a stored box ID (for AGN = the booking layer) skips
      // the whole outlet→program→box name walk.
      let destId: string | null = null
      const boxLink = getDriveLink(b.driveFolders, 'box')
      if (boxLink && await isFolderAlive(boxLink)) destId = boxLink
      const boxViaStored = !!destId
      if (!destId) {
        const layers = shootFolderLayers({
          outletCode: b.outlet.code,
          showName,
          category: b.category, projectId: b.projectId, projectName: b.projectName,
          bookingCode: code, jobName,
        })
        const resolved = await findEpisodeFolderUrls({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(b.outlet.code),
          programFolderName: layers.programFolderName,
          bookingFolderName: layers.bookingFolderName,
          // strict destination for AGN (project box only); others accept the pre-v1.110 box
          bookingFolderNameAlts: layers.bookingSubfolderName ? [] : [legacyBookingFolderName(code, jobName)],
          bookingCode: code, // v1.113.6 — last-resort box match by Production ID (sanitized names drift)
          bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: code,
          episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: episodeLeadUsesId(b.outlet.code, b.episodes) })),
        })
        if (!resolved.bookingFolderId) { base.results.push({ bookingCode: code, skipped: 'box not found (not prepped yet)' }); continue }

        // AGN: box exists but the booking layer doesn't yet → create it (merge is a
        // write op). In dryRun leave dest null (mirrorMove counts all as would-move).
        destId = resolved.bookingFolderId
        if (layers.bookingSubfolderName && !resolved.viaBookingSubfolder) {
          destId = opts.dryRun ? null : await ensureFolderPath(resolved.bookingFolderId, [layers.bookingSubfolderName])
        }
      }
      noteResolve('video-merge', 'box', code, boxViaStored) // v1.154 — id-first coverage gauge
      // self-heal: remember what we just resolved so next time skips the walk.
      // landing was stored at resolve time (stored link, or a unique name match) — never re-store an ambiguous one here
      if (!opts.dryRun && b.id) await rememberDriveLinks(b.id, { box: destId ?? undefined })

      const stats: Stats = { seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0, conflicts: [] }
      await mirrorMove(flatId, destId, code, stats, !!opts.dryRun)
      base.landed += stats.seen; base.moved += stats.moved; base.movedFolders += stats.movedFolders; base.errors += stats.err
      base.results.push({ bookingCode: code, seen: stats.seen, moved: stats.moved, movedFolders: stats.movedFolders, dup: stats.dup, err: stats.err, conflicts: stats.conflicts.length })
      if (!opts.dryRun) await reportConflicts(code, stats.conflicts)
    } catch (e: any) {
      base.errors++
      base.results.push({ bookingCode: code, skipped: `error: ${e?.message || String(e)}` })
    } finally {
      if (!opts.dryRun) unlockMerge(lock)
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
  id?: string
  driveFolders?: unknown
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
  movedFolders: number
  dup: number
  err: number
  conflicts: number       // v1.261 — sync-storm names left in landing (see isConflictName)
  boxFolderUrl?: string | null
}

/** MOVE this ONE booking's NAS landing footage into its VIDEO 2026 box. */
export async function mergeBookingVideo(b: VideoMergeBooking, opts: { dryRun?: boolean } = {}): Promise<BookingVideoMergeResult> {
  const dryRun = !!opts.dryRun
  const zero = { seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0, conflicts: 0 }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'ยังไม่ได้ตั้งค่า Drive', ...zero }
  const code = b.bookingCode
  if (!code) return { skipped: true, reason: 'ไม่มี Production ID', ...zero }
  const isAgency = b.outlet.code === 'AGN'

  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })

  // v1.114 — id-first for both sides; names are the fallback.
  const landingLink = getDriveLink(b.driveFolders, 'landing')
  let flatId: string | null = landingLink && await isFolderAlive(landingLink) ? landingLink : null
  const landingViaStored = !!flatId
  let landingUnique = false
  if (!flatId) {
    const byName = (await listChildFolders(PRODUCTION_TEAM_ROOT)).filter(c => folderNameMatchesCode(c.name, code))
    flatId = byName[0]?.id ?? null
    landingUnique = byName.length === 1 // v1.274 — only an unambiguous match may be stored
  }
  if (!flatId) return { skipped: true, reason: 'ยังไม่มีโฟลเดอร์ใน Production Team (NAS ยังไม่ sync?)', ...zero }
  noteResolve('video-merge', 'landing', code, landingViaStored) // v1.154 — id-first coverage gauge

  let destId: string | null = null
  const boxLink = getDriveLink(b.driveFolders, 'box')
  if (boxLink && await isFolderAlive(boxLink)) destId = boxLink
  const boxViaStored = !!destId
  if (!destId) {
    // v1.112 — AGN merges too (destination = per-booking layer inside the project box).
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
      episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: episodeLeadUsesId(b.outlet.code, b.episodes) })),
    })
    if (!resolved.bookingFolderId) return { skipped: true, reason: 'ยังไม่พบกล่อง Video 2026 (ยังไม่ถูก prep?)', ...zero }

    destId = resolved.bookingFolderId
    if (layers.bookingSubfolderName && !resolved.viaBookingSubfolder) {
      destId = dryRun ? null : await ensureFolderPath(resolved.bookingFolderId, [layers.bookingSubfolderName])
    }
  }
  noteResolve('video-merge', 'box', code, boxViaStored) // v1.154 — id-first coverage gauge
  if (!dryRun && b.id) await rememberDriveLinks(b.id, { landing: landingViaStored || landingUnique ? flatId : undefined, box: destId ?? undefined })

  const stats: Stats = { seen: 0, moved: 0, movedFolders: 0, dup: 0, err: 0, conflicts: [] }
  await mirrorMove(flatId, destId, code, stats, dryRun)
  if (!dryRun) await reportConflicts(code, stats.conflicts)
  return { ...stats, conflicts: stats.conflicts.length, boxFolderUrl: destId ? `https://drive.google.com/drive/folders/${destId}` : null }
}
