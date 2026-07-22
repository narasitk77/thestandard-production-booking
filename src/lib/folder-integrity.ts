/**
 * v1.151 — FOLDER-INTEGRITY worker: the standing "check and repair" pass over
 * every active booking's Drive structure.
 *
 * WHY THIS EXISTS. Folder problems kept coming back in a different shape every
 * week — CAM slots missing from the crew drop zone, per-EP AUDIO gone, boxes
 * carrying a stale job title after a producer edit, camera folders hand-made as
 * "Cam A". Each incident got its own targeted fix, but nothing ever went back
 * and ASKED, for a given booking, "does the tree on Drive still match what this
 * booking says it should be?" — so the next drift was found by the crew, not by
 * us. This worker asks that question on a schedule and repairs what it safely
 * can, so ops stop being the monitoring system.
 *
 * WHAT IT OWNS (and what it deliberately does not):
 *   - It NEVER trashes or moves anything. Only two verbs: CREATE a missing
 *     folder, and RENAME a folder in place (same id → every stored link,
 *     _SHOOT.txt marker and uploaded file stays attached).
 *   - Creation reuses the exact ensure* helpers approve/prep/landing already
 *     use, so a repair produces byte-identical structure to a normal create.
 *   - Anything ambiguous (box vanished but footage exists elsewhere, two
 *     folders claiming one Production ID, a name that doesn't carry the code)
 *     is REPORTED for a human, never guessed at.
 *
 * RENAME SAFETY — the one destructive-looking verb, so it is fenced four ways:
 *   1. id-first: we only ever rename a folder we resolved for THIS booking
 *      (stored link, or a code-matched hit inside the booking's own program
 *      folder) — never a name-search result from elsewhere in the drive;
 *   2. the current name must be one WE generated (isAppShapedName) or carry the
 *      immutable EP lead — an ops-authored "งานพี่ต้น อย่าลบ" is left alone and
 *      reported, because ops intent outranks canonical tidiness;
 *   3. collision check: if a sibling already holds the target name we skip
 *      (Drive allows same-name siblings — that is how the landing dedupe mess
 *      started);
 *   4. every rename is capped by the per-run write budget and audit-logged.
 */
import { prisma } from './db'
import { logAudit } from './audit'
import {
  hasDriveCredentials, findEpisodeFolderUrls, listChildFolders, getFileName, renameDriveItem,
  ensureFolderPath, ensureShootCameraFolders, ensureFlatShootFolders, findChildFolderByCode,
  findFoldersByCode, isFolderAlive, isFootageTreeFolder, listFilesRecursive, getDriveParentFolderId,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName,
  legacyBookingFolderName, landingBookingFolderName, camerasToPreCreate,
  isPhotoAlbumBooking, hasOutletFolderMapping,
} from './outlet-folders'
import { canonicalCameraName } from './camera-folder-normalize'
import { bookingShowName } from './display'
import { getDriveLink, rememberDriveLinks } from './drive-links'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'
const SHOOT_STUB_RE = /^_SHOOT\b.*\.txt$/i

/** Kill switch for the rename repairs (creates + camera-normalize stay on). */
const renameEnabled = () => process.env.FOLDER_INTEGRITY_RENAME !== '0'

/**
 * Is this folder name one that WE generated — "<something> (CODE)" (v1.110) or
 * the legacy "CODE · <something>" / bare "CODE"? Only such a name is treated as
 * a stale app name that may be re-derived. A folder ops renamed to something
 * outside our shapes ("งานพี่ต้น อย่าลบ") is reported, never rewritten — ops
 * intent outranks canonical tidiness, and a rename of a folder holding footage
 * is not undoable from Drive trash.
 */
export function isAppShapedName(name: string, code: string): boolean {
  const n = name.trim()
  const c = code.trim()
  if (!c) return false
  return n === c || n.startsWith(`${c} `) || new RegExp(`\\(${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*$`).test(n)
}

export interface FolderIntegrityResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  scanned: number            // bookings in the window
  checked: number            // bookings actually walked this run
  deferred: number           // left for the next run (write budget / limit)
  fixed: {
    boxCreated: number
    boxRenamed: number
    epCreated: number
    epRenamed: number
    camCreated: number
    camNormalized: number
    landingRepaired: number
    landingRenamed: number
    linksHealed: number
  }
  warnings: string[]
  errors: Array<{ code: string; error: string }>
  actions: string[]
}

function emptyFixed(): FolderIntegrityResult['fixed'] {
  return {
    boxCreated: 0, boxRenamed: 0, epCreated: 0, epRenamed: 0,
    camCreated: 0, camNormalized: 0, landingRepaired: 0, landingRenamed: 0, linksHealed: 0,
  }
}

/** Bangkok (UTC+7, no DST) date key for a Date. */
function bkkDayKey(d: Date): string {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)
}

/** True when the shoot is today or tomorrow in Bangkok — the only window in
 *  which the lean landing policy wants a drop folder to exist. */
export function landingWindow(shootDate: Date, shootEndDate: Date | null, now: Date): boolean {
  const today = bkkDayKey(now)
  const tomorrow = bkkDayKey(new Date(now.getTime() + 24 * 3_600_000))
  const start = bkkDayKey(shootDate)
  const end = bkkDayKey(shootEndDate ?? shootDate)
  return (start <= tomorrow && end >= today)
}

export async function runFolderIntegrity(opts: {
  dryRun?: boolean
  onlyCode?: string
  pastDays?: number
  futureDays?: number
  limit?: number
  /** Hard cap on Drive MUTATIONS per run — the quota guard. Reads are cheap;
   *  writes share the per-user "Write requests per minute" bucket that a
   *  2026-07-21 backfill exhausted at ~161 rows. */
  maxWrites?: number
} = {}): Promise<FolderIntegrityResult> {
  const dryRun = opts.dryRun !== false // SAFE DEFAULT: report-only unless told otherwise
  const now = new Date()
  const envInt = (name: string, fallback: number) => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const pastDays = Math.max(0, opts.pastDays ?? envInt('FOLDER_INTEGRITY_PAST_DAYS', 14))
  const futureDays = Math.max(0, opts.futureDays ?? envInt('FOLDER_INTEGRITY_FUTURE_DAYS', 30))
  const limit = Math.max(1, opts.limit ?? envInt('FOLDER_INTEGRITY_LIMIT', 60))
  const maxWrites = Math.max(1, opts.maxWrites ?? envInt('FOLDER_INTEGRITY_MAX_WRITES', 120))

  const base: FolderIntegrityResult = {
    skipped: false, dryRun, scanned: 0, checked: 0, deferred: 0,
    fixed: emptyFixed(), warnings: [], errors: [], actions: [],
  }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { ...base, skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials' }
  }

  let writes = 0
  const budgetLeft = () => writes < maxWrites
  /** Perform one mutation under the write budget; returns false when skipped. */
  const spend = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (!budgetLeft()) return false
    base.actions.push(label)
    if (dryRun) { writes++; return true }
    await fn()
    writes++
    return true
  }

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      bookingCode: { not: null },
      shootDate: {
        gte: new Date(now.getTime() - pastDays * 24 * 3_600_000),
        lte: new Date(now.getTime() + futureDays * 24 * 3_600_000),
      },
    },
    orderBy: { shootDate: 'asc' },
    select: {
      id: true, bookingCode: true, driveFolders: true, shootDate: true, shootEndDate: true,
      projectId: true, projectName: true, category: true, cameraCount: true, micCount: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: {
        orderBy: { sequence: 'asc' },
        select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } },
      },
    },
  })
  base.scanned = bookings.length

  for (const b of bookings) {
    const code = b.bookingCode as string
    if (opts.onlyCode && code.toUpperCase() !== opts.onlyCode.toUpperCase()) continue
    if (base.checked >= limit || !budgetLeft()) { base.deferred++; continue }
    // Photo-album jobs live in a different drive with no EP/CAM layers, and the
    // approve route owns them; nothing here to verify.
    if (isPhotoAlbumBooking(b.episodes) || !hasOutletFolderMapping(b.outlet.code)) continue
    base.checked++

    try {
      const isAgency = b.outlet.code === 'AGN'
      const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
      const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
      const layers = shootFolderLayers({
        outletCode: b.outlet.code, showName, category: b.category,
        projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
      })
      const epNames = b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency }))
      const cams = camerasToPreCreate(b.cameraCount, b.micCount)

      // ── resolve the box, id-first ────────────────────────────────────────
      const boxLink = getDriveLink(b.driveFolders, 'box')
      let boxId: string | null = boxLink && await isFolderAlive(boxLink) ? boxLink : null
      // The per-booking layer is what we verify; for AGN that is the subfolder
      // INSIDE the shared project box (never the project box itself).
      let resolvedViaSubfolder = !!boxId
      if (!boxId) {
        const resolved = await findEpisodeFolderUrls({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(b.outlet.code),
          programFolderName: layers.programFolderName,
          bookingFolderName: layers.bookingFolderName,
          bookingFolderNameAlts: layers.bookingSubfolderName ? [] : [legacyBookingFolderName(code, jobName)],
          bookingCode: layers.bookingSubfolderName ? undefined : code,
          bookingFolderCode: isAgency ? (b.projectId ?? undefined) : undefined,
          bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: code,
          episodeFolderNames: epNames,
        })
        boxId = resolved.bookingFolderId
        resolvedViaSubfolder = layers.bookingSubfolderName ? resolved.viaBookingSubfolder : true
        if (boxId && !dryRun) { await rememberDriveLinks(b.id, { box: boxId }); base.fixed.linksHealed++ }
        else if (boxId) base.fixed.linksHealed++
      }

      // ── box missing entirely → create, unless footage already lives somewhere ──
      if (!boxId) {
        let footageElsewhere = false
        for (const c of await findFoldersByCode(code)) {
          if (!(await isFootageTreeFolder(c.id))) continue
          const some = await listFilesRecursive(c.id, { maxFiles: 4 })
          if (some.some(f => !SHOOT_STUB_RE.test(f.name))) { footageElsewhere = true; break }
        }
        if (footageElsewhere) {
          base.warnings.push(`${code}: หา box ตามชื่อไม่เจอ แต่มีไฟล์อยู่ที่อื่นใต้รหัสนี้ — อาจถูกย้ายด้วยมือ (ไม่สร้างใหม่)`)
          continue
        }
        const ok = await spend(`${code}: create box "${layers.bookingSubfolderName || layers.bookingFolderName}"`, async () => {
          const { bookingFolderId } = await ensureShootCameraFolders({
            rootFolderId: root,
            outletCanonicalName: outletDriveFolderName(b.outlet.code),
            programFolderName: layers.programFolderName,
            bookingFolderName: layers.bookingFolderName,
            bookingSubfolderName: layers.bookingSubfolderName,
            bookingSubfolderCode: code,
            bookingCode: isAgency ? undefined : code,
            bookingFolderCode: isAgency ? (b.projectId ?? undefined) : undefined,
            cameras: cams,
            episodeFolderNames: epNames.length ? epNames : undefined,
          })
          await rememberDriveLinks(b.id, { box: bookingFolderId })
        })
        if (ok) base.fixed.boxCreated++
        continue // freshly created = already canonical; nothing to compare
      }

      // ── box NAME drift ───────────────────────────────────────────────────
      const expectedBoxName = layers.bookingSubfolderName || layers.bookingFolderName
      if (expectedBoxName && resolvedViaSubfolder) {
        const actual = await getFileName(boxId)
        if (actual && actual !== expectedBoxName) {
          // Only rewrite a name WE would have generated (see isAppShapedName);
          // an ops-authored label keeps its name and gets a digest line.
          if (!isAppShapedName(actual, code)) {
            base.warnings.push(`${code}: box ชื่อ "${actual}" ไม่ใช่รูปแบบของระบบ — ไม่แตะ (ควรเป็น "${expectedBoxName}")`)
          } else if (!renameEnabled()) {
            base.warnings.push(`${code}: box ควรเปลี่ยนชื่อเป็น "${expectedBoxName}" (ปิด rename อยู่)`)
          } else {
            const parentKids = layers.bookingSubfolderName
              ? await listChildFolders((await parentOf(boxId)) || '')
              : []
            const collision = parentKids.some(k => k.id !== boxId && k.name === expectedBoxName)
            if (collision) {
              base.warnings.push(`${code}: จะเปลี่ยนชื่อ box เป็น "${expectedBoxName}" ไม่ได้ — มีโฟลเดอร์ชื่อนี้อยู่แล้ว`)
            } else if (await spend(`${code}: rename box "${actual}" → "${expectedBoxName}"`, () => renameDriveItem(boxId!, expectedBoxName))) {
              base.fixed.boxRenamed++
            }
          }
        }
      }

      // ── EP layer: create missing, rename retitled ────────────────────────
      const boxKids = await listChildFolders(boxId)
      const epParents: string[] = []
      if (epNames.length === 0) {
        epParents.push(boxId)
      } else {
        for (const want of epNames) {
          const lead = want.split(' · ')[0]?.trim()
          const exact = boxKids.find(k => k.name === want)
          const byLead = lead ? boxKids.find(k => k.name === lead || k.name.startsWith(`${lead} `)) : undefined
          const hit = exact ?? byLead
          if (!hit) {
            let createdId: string | null = null
            const ok = await spend(`${code}: create EP "${want}"`, async () => { createdId = await ensureFolderPath(boxId!, [want]) })
            if (ok) { base.fixed.epCreated++; if (createdId) epParents.push(createdId) }
            continue
          }
          epParents.push(hit.id)
          if (hit.name !== want && renameEnabled()) {
            const collision = boxKids.some(k => k.id !== hit.id && k.name === want)
            if (collision) {
              base.warnings.push(`${code}: จะเปลี่ยนชื่อ EP เป็น "${want}" ไม่ได้ — มีโฟลเดอร์ชื่อนี้อยู่แล้ว`)
            } else if (await spend(`${code}: rename EP "${hit.name}" → "${want}"`, () => renameDriveItem(hit.id, want))) {
              base.fixed.epRenamed++
            }
          }
        }
      }

      // ── CAM/AUDIO layer under each EP parent ─────────────────────────────
      for (const parent of epParents) {
        const kids = await listChildFolders(parent)
        // normalize hand-made variants first ("Cam A" → "CAM-A"), so the
        // missing-slot check below doesn't create a canonical twin beside one.
        for (const k of kids) {
          const canon = canonicalCameraName(k.name)
          if (!canon) continue
          if (kids.some(other => other.id !== k.id && other.name === canon)) {
            base.warnings.push(`${code}: "${k.name}" ซ้ำกับ "${canon}" ที่มีอยู่แล้ว — รวมเอง`)
            continue
          }
          if (await spend(`${code}: normalize "${k.name}" → "${canon}"`, () => renameDriveItem(k.id, canon))) {
            base.fixed.camNormalized++
            k.name = canon // so the missing-slot pass sees the canonical name
          }
        }
        for (const cam of cams) {
          if (kids.some(k => k.name === cam)) continue
          if (await spend(`${code}: create ${cam}`, () => ensureFolderPath(parent, [cam]))) base.fixed.camCreated++
        }
      }

      // ── LANDING drop zone (today/tomorrow only — the lean policy) ────────
      if (landingWindow(b.shootDate, b.shootEndDate, now) && cams.length > 0) {
        const wantLanding = landingBookingFolderName({
          bookingCode: code, projectName: b.projectName, program: b.program, episodes: b.episodes,
        })
        const landingLink = getDriveLink(b.driveFolders, 'landing')
        const landingId = landingLink && await isFolderAlive(landingLink)
          ? landingLink
          : await findChildFolderByCode(PRODUCTION_TEAM_ROOT, code)

        if (landingId) {
          // Landing folders are REPORT-ONLY for names: this drive is mirrored to
          // the office NAS over SMB, and renaming a folder mid-sync is how the
          // v1.111 "(1)" conflict duplicates appeared. Every lookup here matches
          // by Production ID anyway, so a stale display name is cosmetic.
          const actual = await getFileName(landingId)
          if (actual && actual !== wantLanding) {
            base.warnings.push(`${code}: ชื่อ drop folder ไม่ตรง ("${actual}" ควรเป็น "${wantLanding}") — ไม่เปลี่ยนให้ (มิเรอร์ลง NAS อยู่)`)
          }
        }
        // ensureFlatShootFolders is idempotent: it reuses the folder matched by
        // Production ID and only fills in the EP/CAM slots that are missing —
        // exactly the repair the crew needs before a shoot day.
        const missingLanding = !landingId
        const ok = await spend(
          `${code}: ${missingLanding ? 'create' : 'repair'} landing drop folders`,
          async () => {
            const { bookingFolderId } = await ensureFlatShootFolders({
              rootFolderId: PRODUCTION_TEAM_ROOT,
              bookingCode: code,
              bookingFolderName: wantLanding,
              cameras: cams,
              episodeFolderNames: epNames.length ? epNames : undefined,
            })
            await rememberDriveLinks(b.id, { landing: bookingFolderId })
          },
        )
        if (ok) base.fixed.landingRepaired++
      }
    } catch (e: any) {
      base.errors.push({ code, error: e?.message || String(e) })
    }
  }

  if (!dryRun) {
    const changed = Object.values(base.fixed).reduce((n, v) => n + v, 0)
    if (changed > 0 || base.errors.length > 0) {
      logAudit({
        actorEmail: 'folder-integrity-worker',
        action: 'drive.folder_integrity',
        entityType: 'Drive',
        entityId: 'footage-tree',
        changes: { ...base.fixed, warnings: base.warnings.length, errors: base.errors.length, checked: base.checked },
      })
    }
  }
  return base
}

/** Parent folder id (first parent) — for the box-rename collision check. */
async function parentOf(folderId: string): Promise<string | null> {
  try { return await getDriveParentFolderId(folderId) } catch { return null }
}
