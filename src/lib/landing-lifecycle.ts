/**
 * Landing drop-folder lifecycle (v1.139).
 *
 * The "Production Team" landing drive is where crew/NAS drop footage, ONE flat
 * folder per shoot: "<show · job> (<Production ID>)". Policy (per ops, 2026-07-09
 * — keep the drive lean; folders for done/unrelated shoots make it hard to find
 * the right one):
 *
 *   • CREATE the drop folder the EVENING BEFORE the shoot — for the NEXT day's
 *     shoots only. Never pre-create further ahead (a booking confirmed weeks out
 *     does NOT get a landing folder until the night before).
 *   • KEEP it through the shoot + a short upload-grace window (crew upload late
 *     batches; video-merge moves footage to the box but no longer trashes the
 *     shell — see v1.137).
 *   • REMOVE it once the shoot is well past AND its footage is delivered (the
 *     folder is empty of real files), so the drive only ever shows upcoming +
 *     in-flight shoots.
 *
 * This is run nightly by scripts/landing-worker.js. Idempotent + dry-run first;
 * only EMPTY folders (no real, non-`_SHOOT` file anywhere inside) are ever
 * trashed, to Shared-Drive trash (recoverable ~30 days). Full policy doc:
 * docs/landing-folder-policy.md.
 */
import { prisma } from './db'
import {
  ensureFlatShootFolders, listChildFolders, listFilesRecursive, trashDriveItem, hasDriveCredentials,
  findFoldersByCode,
} from './google-drive'
import {
  landingBookingFolderName, buildEpisodeFolderName, camerasToPreCreate,
  hasOutletFolderMapping, isPhotoAlbumBooking,
} from './outlet-folders'
import { rememberDriveLinks } from './drive-links'
import { computeTypeDroppedId } from './id-migration'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'
const SHOOT_STUB_RE = /^_SHOOT\b.*\.txt$/i

/** Bangkok calendar-day boundaries (UTC midnight of the BKK date), offset by N days. */
function bangkokDayRange(offsetDays = 0, now: Date = new Date()): { start: Date; end: Date } {
  const bkk = new Date(now.getTime() + 7 * 3_600_000)
  const start = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) + offsetDays * 24 * 3_600_000)
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) }
}

function codeFromFolderName(name: string): string | null {
  const m = name.match(/\(([A-Za-z0-9-]+)\)\s*$/)
  if (!m) return null
  return (computeTypeDroppedId(m[1]) ?? m[1]).toUpperCase()
}

async function hasRealFiles(folderId: string): Promise<boolean> {
  const files = await listFilesRecursive(folderId, { maxFiles: 6 })
  return files.some(f => !SHOOT_STUB_RE.test(f.name))
}

export interface LandingLifecycleResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  targetDay: string           // the BKK date we created folders for (next day)
  created: number
  createErrors: number
  removedPastEmpty: number
  keptRecent: number          // past folders kept (still within grace / have files)
  removeErrors: number
  keepPastDays: number
  actions: string[]
}

export async function manageLandingFolders(
  opts: { dryRun?: boolean; createOffsetDays?: number; keepPastDays?: number } = {},
): Promise<LandingLifecycleResult> {
  const dryRun = !!opts.dryRun
  const createOffsetDays = opts.createOffsetDays ?? 1 // tomorrow
  const envKeep = Number(process.env.LANDING_KEEP_PAST_DAYS)
  const keepPastDays = Math.max(0, opts.keepPastDays ?? (Number.isFinite(envKeep) ? envKeep : 3))
  const create = bangkokDayRange(createOffsetDays)
  const today = bangkokDayRange(0)
  const cutoff = new Date(today.start.getTime() - keepPastDays * 24 * 3_600_000) // remove empties for shoots strictly before this
  const targetDay = create.start.toISOString().slice(0, 10)

  const base: LandingLifecycleResult = {
    skipped: false, dryRun, targetDay, created: 0, createErrors: 0,
    removedPastEmpty: 0, keptRecent: 0, removeErrors: 0, keepPastDays, actions: [],
  }
  if (!hasDriveCredentials()) return { ...base, skipped: true, reason: 'no Drive credentials' }

  // ── CREATE: next day's shoots ────────────────────────────────────────────
  const nextDay = await prisma.booking.findMany({
    where: {
      shootDate: { gte: create.start, lt: create.end },
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null, bookingCode: { not: null },
    },
    select: {
      id: true, bookingCode: true, cameraCount: true, micCount: true,
      projectName: true, outlet: { select: { code: true } },
      program: { select: { code: true, name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } } },
    },
  })
  for (const b of nextDay) {
    if (!hasOutletFolderMapping(b.outlet.code) || isPhotoAlbumBooking(b.episodes)) continue
    const cams = camerasToPreCreate(b.cameraCount)
    if (cams.length === 0) continue
    const name = landingBookingFolderName({ bookingCode: b.bookingCode!, projectName: b.projectName, program: b.program, episodes: b.episodes })
    base.actions.push(`create landing "${name}" (${targetDay})`)
    if (!dryRun) {
      try {
        const epNames = b.episodes.length ? b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: b.outlet.code === 'AGN' })) : undefined
        const lid = (await ensureFlatShootFolders({ rootFolderId: PRODUCTION_TEAM_ROOT, bookingCode: b.bookingCode!, bookingFolderName: name, cameras: cams, episodeFolderNames: epNames })).bookingFolderId
        await rememberDriveLinks(b.id, { landing: lid })
      } catch (e: any) { base.createErrors++; base.actions.push(`  ERROR create: ${e?.message || e}`); continue }
    }
    base.created++
  }

  // ── CLEANUP: trash EMPTY landing folders for shoots older than the grace window ──
  // v1.146 review fix — the age check must use the shoot's LAST day
  // (shootEndDate ?? shootDate), not day 1: with keepPastDays=1, day 3 of a
  // 3-day shoot already had shootDate 2 days in the past, so a drop folder
  // that was transiently empty between upload batches got trashed mid-shoot.
  const codeToLastShootDay = new Map<string, Date>()
  const recent = await prisma.booking.findMany({
    where: { bookingCode: { not: null }, deletedAt: null },
    select: { bookingCode: true, shootDate: true, shootEndDate: true },
  })
  for (const b of recent) if (b.bookingCode) codeToLastShootDay.set(b.bookingCode.toUpperCase(), b.shootEndDate ?? b.shootDate)

  const folders = await listChildFolders(PRODUCTION_TEAM_ROOT)
  for (const f of folders) {
    const code = codeFromFolderName(f.name)
    if (!code) continue // not a shoot drop folder (e.g. a manual project folder) — leave
    const shootDate = codeToLastShootDay.get(code)
    if (!shootDate) continue // unknown booking — leave (safety)
    if (shootDate.getTime() >= cutoff.getTime()) { base.keptRecent++; continue } // within grace / today / future
    // past the grace window → remove ONLY if empty (footage delivered)
    let empty = false
    try { empty = !(await hasRealFiles(f.id)) }
    catch (e: any) { base.removeErrors++; base.actions.push(`  ERROR check "${f.name}": ${e?.message || e}`); continue }
    if (!empty) { base.keptRecent++; continue } // still holds footage — never trash
    base.actions.push(`trash past-empty landing "${f.name}" (shoot ${shootDate.toISOString().slice(0, 10)} < ${cutoff.toISOString().slice(0, 10)})`)
    if (!dryRun) {
      try { await trashDriveItem(f.id) } catch (e: any) { base.removeErrors++; base.actions.push(`  ERROR trash: ${e?.message || e}`); continue }
    }
    base.removedPastEmpty++
  }

  return base
}

/**
 * v1.141 — create ONE booking's landing drop folder on demand ("ขอเพิ่มพิเศษ"):
 * a specific shoot (often a past/completed one whose folder was pruned) needs a
 * drop target so crew can upload. Idempotent — reuses the folder if it exists.
 */
export async function ensureLandingForBooking(
  bookingCode: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; dryRun: boolean; bookingCode: string; created?: string; folderId?: string | null; url?: string | null; reason?: string }> {
  const dryRun = !!opts.dryRun
  const code = bookingCode.trim().toUpperCase()
  if (!hasDriveCredentials()) return { ok: false, dryRun, bookingCode: code, reason: 'no Drive credentials' }

  const b = await prisma.booking.findFirst({
    where: { bookingCode: { equals: code, mode: 'insensitive' }, deletedAt: null },
    select: {
      id: true, bookingCode: true, status: true, cameraCount: true, micCount: true,
      projectName: true, outlet: { select: { code: true } },
      program: { select: { code: true, name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } } },
    },
  })
  if (!b || !b.bookingCode) return { ok: false, dryRun, bookingCode: code, reason: 'booking not found' }
  if (!hasOutletFolderMapping(b.outlet.code)) return { ok: false, dryRun, bookingCode: code, reason: `outlet ${b.outlet.code} has no folder mapping` }
  if (isPhotoAlbumBooking(b.episodes)) return { ok: false, dryRun, bookingCode: code, reason: 'photo-album booking has no Production Team landing folder' }
  const cams = camerasToPreCreate(b.cameraCount)
  if (cams.length === 0) return { ok: false, dryRun, bookingCode: code, reason: 'no cameras (block shot / unspecified) — no landing folder' }

  // A booking whose footage is ALREADY delivered (real files exist under its
  // Production ID anywhere — typically moved into the VIDEO 2026 box) does NOT
  // need a landing drop folder: making one just resurrects an empty shell the
  // lean lifecycle correctly cleans up. Mirrors prep-folders' delivered-check.
  // (2026-07-09: TSS-KDM-260708-01 had 84 files already in the box — the drop
  // folder was redundant. Per ops: "งานไหนย้ายไฟล์แล้ว ไม่ต้องสร้าง drop มา".)
  try {
    for (const c of await findFoldersByCode(b.bookingCode)) {
      const some = await listFilesRecursive(c.id, { maxFiles: 4 })
      if (some.some(f => !SHOOT_STUB_RE.test(f.name))) {
        return { ok: false, dryRun, bookingCode: code, reason: 'footage already delivered — no landing drop folder needed' }
      }
    }
  } catch (e: any) {
    console.warn('[landing] delivered-check failed (continuing with create):', code, e?.message || e)
  }

  const name = landingBookingFolderName({ bookingCode: b.bookingCode, projectName: b.projectName, program: b.program, episodes: b.episodes })
  if (dryRun) return { ok: true, dryRun, bookingCode: code, created: name }
  const epNames = b.episodes.length ? b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: b.outlet.code === 'AGN' })) : undefined
  const fid = (await ensureFlatShootFolders({ rootFolderId: PRODUCTION_TEAM_ROOT, bookingCode: b.bookingCode, bookingFolderName: name, cameras: cams, episodeFolderNames: epNames })).bookingFolderId
  await rememberDriveLinks(b.id, { landing: fid })
  return { ok: true, dryRun, bookingCode: code, created: name, folderId: fid, url: fid ? `https://drive.google.com/drive/folders/${fid}` : null }
}

export interface LandingPruneResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  today: string
  trashed: number
  keptToday: number
  keptWithFiles: string[]   // non-today shoot folders that HOLD footage — kept, reported
  keptManual: string[]      // folders with no Production ID in the name — kept, reported
  keptByName: string[]      // matched a keepNames entry
  errors: number
  actions: string[]
}

/**
 * v1.140 — one-off prune: keep ONLY today's shoot drop folders (Bangkok), plus
 * anything in `keepNames`. A non-today shoot folder is trashed only when EMPTY;
 * one that still holds real footage is kept + reported (never silent data loss),
 * and folders with no Production ID in the name (manual folders) are left alone +
 * reported. Trash is recoverable ~30 days. dry-run first.
 */
export async function pruneLandingToToday(
  opts: { dryRun?: boolean; keepNames?: string[] } = {},
): Promise<LandingPruneResult> {
  const dryRun = !!opts.dryRun
  const keepNames = (opts.keepNames || []).map(s => s.trim()).filter(Boolean)
  const today = bangkokDayRange(0)
  const base: LandingPruneResult = {
    skipped: false, dryRun, today: today.start.toISOString().slice(0, 10),
    trashed: 0, keptToday: 0, keptWithFiles: [], keptManual: [], keptByName: [], errors: 0, actions: [],
  }
  if (!hasDriveCredentials()) return { ...base, skipped: true, reason: 'no Drive credentials' }

  // v1.146 review fix — "today's shoot" must include a multi-day shoot whose
  // range SPANS today (day 2 of a 3-day shoot), not just one that STARTS today.
  const codeToShootRange = new Map<string, { start: Date; end: Date }>()
  const rows = await prisma.booking.findMany({ where: { bookingCode: { not: null }, deletedAt: null }, select: { bookingCode: true, shootDate: true, shootEndDate: true } })
  for (const b of rows) if (b.bookingCode) codeToShootRange.set(b.bookingCode.toUpperCase(), { start: b.shootDate, end: b.shootEndDate ?? b.shootDate })

  const folders = await listChildFolders(PRODUCTION_TEAM_ROOT)
  for (const f of folders) {
    if (keepNames.some(k => f.name.includes(k))) { base.keptByName.push(f.name); continue }
    const code = codeFromFolderName(f.name)
    if (!code) { base.keptManual.push(f.name); continue } // manual folder — never auto-delete
    const range = codeToShootRange.get(code)
    if (range && range.start.getTime() < today.end.getTime() && range.end.getTime() >= today.start.getTime()) {
      base.keptToday++; continue // shoot runs today (incl. mid-multi-day) — keep
    }
    const shootDate = range?.start
    // not today's → trash only if empty; keep + report if it holds footage
    let empty = false
    try { empty = !(await hasRealFiles(f.id)) }
    catch (e: any) { base.errors++; base.actions.push(`ERROR check "${f.name}": ${e?.message || e}`); continue }
    if (!empty) { base.keptWithFiles.push(f.name); continue }
    base.actions.push(`trash "${f.name}" (${code}${shootDate ? ` · shoot ${shootDate.toISOString().slice(0, 10)}` : ' · no booking'})`)
    if (!dryRun) {
      try { await trashDriveItem(f.id) } catch (e: any) { base.errors++; base.actions.push(`  ERROR trash: ${e?.message || e}`); continue }
    }
    base.trashed++
  }
  return base
}
