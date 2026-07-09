/**
 * _SHOOT marker reconciler (v1.135).
 *
 * The footage crawler (PMC side) reads one `_SHOOT` marker per shoot to learn its
 * Production ID + context. The problem it hit (Neo memo 2026-07-09, item 3): an
 * AGN project box can hold TWO markers for the same shoot —
 *
 *   09 · Content Agency/…/PP-26-036 · GWM…/            (project box)
 *   ├── _SHOOT-AGN-260708-LOC-01.txt                   ← box-level, PRE-migration id (has TYPE)
 *   └── GWM… (AGN-260708-01)/_SHOOT.txt                ← per-booking subfolder, current id
 *
 * so the crawler ingests both and files TWO footage cards for one shoot (the
 * TYPE-bearing one pointing at the whole project box). Root cause: pre-v1.112
 * wrote box-level `_SHOOT-<code>.txt`; v1.112 moved to a per-booking subfolder
 * `_SHOOT.txt`; the v1.109 ID migration dropped the [TYPE] segment — but nothing
 * ever removed the old box-level files, so they linger and re-appear every crawl.
 *
 * This reconciler enforces the invariant **"exactly one _SHOOT marker per booking,
 * inside its per-booking subfolder."** Per AGN project box it:
 *   - collapses duplicate `_SHOOT.txt` within each per-booking subfolder (keep newest),
 *   - for each box-level `_SHOOT-<id>.txt`: resolves the booking (parsing the id and
 *     dropping any legacy [TYPE] so `AGN-260708-LOC-01` maps to the DB's `AGN-260708-01`),
 *     then — if that booking already has a subfolder marker — TRASHES the box-level
 *     duplicate; if the subfolder exists but has no marker yet, MOVES the box-level file
 *     in (renamed `_SHOOT.txt`); if it maps to no live booking, TRASHES it as stale.
 *
 * Everything trashed is a small, regenerable text stub going to Shared-Drive trash
 * (recoverable ~30 days) — footage folders are never touched. Idempotent + dry-run
 * first. Powers the one-time cleanup endpoint AND the supervised worker (so any
 * future drift — re-imports, manual Drive edits — self-heals).
 */
import { prisma } from './db'
import {
  listChildFolders, listFilesInFolder, trashDriveItem, moveFileToFolder,
  renameDriveItem, findProgramFolderId, dedupeShootInfoFiles, hasDriveCredentials,
} from './google-drive'
import { outletDriveFolderName, shootFolderLayers, folderNameMatchesCode } from './outlet-folders'
import { computeTypeDroppedId } from './id-migration'
import { EPISODE_ID_RE_LOOSE } from './episode-id'

const SHOOT_FILE_RE = /^_SHOOT.*\.txt$/i
const CANONICAL_MARKER = '_SHOOT.txt'

/** Normalize any Production ID to its current typeless canonical (drops [TYPE]). */
function normalizeCode(id: string): string {
  return (computeTypeDroppedId(id) ?? id).trim().toUpperCase()
}

/** Pull a Production ID out of a box-level marker filename "_SHOOT-<id>.txt". */
export function idFromMarkerName(name: string): string | null {
  const m = name.match(/^_SHOOT-(.+)\.txt$/i)
  if (!m) return null
  const loose = m[1].match(EPISODE_ID_RE_LOOSE)
  return loose ? loose[1] : m[1].trim()
}

type MarkerAction =
  | { kind: 'trash-duplicate'; name: string; code: string }
  | { kind: 'trash-stale'; name: string; parsedId: string | null }
  | { kind: 'move-into-booking'; name: string; code: string; toFolder: string }
  | { kind: 'dedupe-subfolder'; folder: string; trashed: number }

export interface ShootMarkerReconcileResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  projects: number
  trashedDuplicates: number
  movedIntoBooking: number
  trashedStale: number
  dedupedInSubfolder: number
  errors: number
  results: Array<{
    projectId: string
    box?: string
    boxUrl?: string
    skipped?: string
    actions?: string[]
  }>
}

export async function reconcileShootMarkers(
  opts: { dryRun?: boolean; projectId?: string; limitProjects?: number } = {},
): Promise<ShootMarkerReconcileResult> {
  const dryRun = !!opts.dryRun
  const base: ShootMarkerReconcileResult = {
    skipped: false, dryRun, projects: 0,
    trashedDuplicates: 0, movedIntoBooking: 0, trashedStale: 0, dedupedInSubfolder: 0,
    errors: 0, results: [],
  }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { ...base, skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials' }
  }

  // AGN project bookings — the only layout with a shared box + sibling markers.
  const bookings = await prisma.booking.findMany({
    where: {
      outlet: { code: 'AGN' },
      projectId: { not: null },
      bookingCode: { not: null },
      deletedAt: null,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    },
    select: {
      bookingCode: true, status: true, projectId: true, projectName: true, category: true,
    },
  })

  const byProject = new Map<string, typeof bookings>()
  for (const b of bookings) {
    const g = byProject.get(b.projectId!) || []
    g.push(b)
    byProject.set(b.projectId!, g)
  }

  const canon = outletDriveFolderName('AGN')
  let projectsSeen = 0
  for (const [projectId, group] of Array.from(byProject)) {
    if (opts.limitProjects && projectsSeen >= opts.limitProjects) break
    projectsSeen++
    base.projects++
    const actions: string[] = []
    try {
      // Locate the project box: category box(es) → child matched by projectId.
      const catNames = Array.from(new Set(group.map(b =>
        shootFolderLayers({ outletCode: 'AGN', showName: '', category: b.category, projectId, projectName: b.projectName, bookingCode: b.bookingCode!, jobName: null }).programFolderName,
      )))
      let boxId: string | null = null, boxName = ''
      for (const cat of catNames) {
        const pid = await findProgramFolderId(root, canon, cat)
        if (!pid) continue
        const child = (await listChildFolders(pid)).find(f => folderNameMatchesCode(f.name, projectId))
        if (child) { boxId = child.id; boxName = child.name; break }
      }
      if (!boxId) { base.results.push({ projectId, skipped: 'project box not found on Drive' }); continue }

      const codes = group.map(b => b.bookingCode!.toUpperCase())
      const kids = await listChildFolders(boxId)

      // Per-booking subfolder (matched by code) → { id, hasCanonical }. Also
      // collapse duplicate `_SHOOT.txt` inside each so "hasCanonical" means one.
      const subByCode = new Map<string, { id: string; hasCanonical: boolean }>()
      for (const code of codes) {
        const kid = kids.find(k => folderNameMatchesCode(k.name, code))
        if (!kid) continue
        const dd = await dedupeShootInfoFiles(kid.id, { dryRun })
        if (dd.totalTrashed > 0) {
          base.dedupedInSubfolder += dd.totalTrashed
          actions.push(`dedupe "${kid.name}": trashed ${dd.totalTrashed} duplicate _SHOOT.txt`)
        }
        const files = await listFilesInFolder(kid.id)
        const hasCanonical = files.some(f => SHOOT_FILE_RE.test(f.name))
        subByCode.set(code, { id: kid.id, hasCanonical })
      }

      // Box-LEVEL markers — the pre-v1.112 leftovers that duplicate the shoot.
      const boxFiles = await listFilesInFolder(boxId)
      for (const f of boxFiles) {
        if (!SHOOT_FILE_RE.test(f.name)) continue
        const parsedId = idFromMarkerName(f.name)
        if (!parsedId) {
          // A bare "_SHOOT.txt" at the project-box ROOT is ambiguous (many bookings) — leave + report.
          actions.push(`⚠ box-level "${f.name}" has no Production ID in its name — left alone`)
          continue
        }
        const code = normalizeCode(parsedId)
        const sub = codes.includes(code) ? subByCode.get(code) : undefined

        if (!codes.includes(code)) {
          // Maps to no live booking of this project → stale/dead → trash (regenerable).
          actions.push(`trash STALE box-level "${f.name}" (no live booking ${code})`)
          if (!dryRun) {
            try { await trashDriveItem(f.id) } catch (e: any) { base.errors++; actions.push(`  ERROR trash: ${e?.message || e}`); continue }
          }
          base.trashedStale++
        } else if (sub && sub.hasCanonical) {
          // Booking already has its canonical subfolder marker → this box-level file is the DUPLICATE.
          actions.push(`trash DUPLICATE box-level "${f.name}" (canonical exists in booking folder for ${code})`)
          if (!dryRun) {
            try { await trashDriveItem(f.id) } catch (e: any) { base.errors++; actions.push(`  ERROR trash: ${e?.message || e}`); continue }
          }
          base.trashedDuplicates++
        } else if (sub && !sub.hasCanonical) {
          // Subfolder exists but has no marker yet → move this one in as the canonical _SHOOT.txt.
          actions.push(`move box-level "${f.name}" → booking folder as _SHOOT.txt (${code})`)
          if (!dryRun) {
            try {
              await moveFileToFolder(f.id, sub.id, boxId)
              await renameDriveItem(f.id, CANONICAL_MARKER)
            } catch (e: any) { base.errors++; actions.push(`  ERROR move: ${e?.message || e}`); continue }
          }
          sub.hasCanonical = true // a later box-level marker for the same booking now trashes as a dup
          base.movedIntoBooking++
        } else {
          // Booking exists but has no per-booking subfolder yet (never approved/prepped) →
          // this is the sole marker; leave it (approve will build the box later).
          actions.push(`keep box-level "${f.name}" (no booking subfolder yet for ${code})`)
        }
      }

      base.results.push({
        projectId, box: boxName,
        boxUrl: `https://drive.google.com/drive/folders/${boxId}`,
        actions,
      })
    } catch (e: any) {
      base.errors++
      base.results.push({ projectId, skipped: `error: ${e?.message || String(e)}`, actions })
    }
  }

  return base
}
