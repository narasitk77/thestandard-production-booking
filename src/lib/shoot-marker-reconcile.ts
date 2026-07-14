/**
 * _SHOOT marker reconciler (v1.135; thorough content-audit v1.136).
 *
 * The footage crawler (PMC side) reads one `_SHOOT` marker per shoot to learn its
 * Production ID + context. Two classes of drift break that (Neo memo 2026-07-09):
 *
 *  - DUPLICATES (item 3): an AGN project box holds TWO markers for one shoot —
 *      09 · Content Agency/…/PP-26-036 · GWM…/            (project box)
 *      ├── _SHOOT-AGN-260708-LOC-01.txt                   ← box-level, pre-migration (has [TYPE])
 *      └── GWM… (AGN-260708-01)/_SHOOT.txt                ← per-booking subfolder, current id
 *    so the crawler files TWO cards per shoot. Root cause: pre-v1.112 wrote
 *    box-level `_SHOOT-<code>.txt`; v1.112 moved to a per-booking `_SHOOT.txt`;
 *    the v1.109 ID migration dropped [TYPE] — nothing removed the old files.
 *
 *  - CONTENT drift (items 1 + 2): a marker's `Production ID :` line or date can
 *    disagree with the DB — an old [TYPE] id, or a Buddhist-era date (pre-v1.134
 *    rendered `2 ก.ค. 2569`/`3112`).
 *
 * This reconciler enforces **"exactly one _SHOOT marker per booking, in its
 * per-booking subfolder, whose content matches the DB."** Per AGN project box it:
 *   1. dedupes each subfolder's `_SHOOT.txt` (keep newest),
 *   2. for each box-level `_SHOOT-<id>.txt`: resolves the booking (parse id, drop
 *      any [TYPE] so `AGN-260708-LOC-01` → the DB's `AGN-260708-01`), then trashes
 *      the duplicate / moves it in if the subfolder lacks a marker / trashes it as
 *      stale if it maps to no live booking,
 *   3. reads each surviving canonical marker and, if its Production ID line ≠ the
 *      DB code OR its date is Buddhist-era, REWRITES it from the DB (correct id +
 *      Gregorian date); creates one if a CONFIRMED/COMPLETED booking's box has none,
 *   4. flags — but never auto-renames — a subfolder whose embedded id still carries
 *      a [TYPE] (folder rename is regenerateBookingId's job; reported for a human).
 *
 * Only small regenerable `_SHOOT` stubs are trashed (Shared-Drive trash,
 * recoverable ~30 days); footage folders are never touched. Idempotent (steady
 * state does nothing) + dry-run first. Powers a nightly worker that emails a
 * digest so drift can never accumulate silently.
 */
import { prisma } from './db'
import {
  listChildFolders, listFilesInFolder, trashDriveItem, moveFileToFolder,
  renameDriveItem, findProgramFolderId, dedupeShootInfoFiles, upsertTextFile,
  readDriveTextFile, hasDriveCredentials,
} from './google-drive'
import { outletDriveFolderName, shootFolderLayers, folderNameMatchesCode } from './outlet-folders'
import { computeTypeDroppedId } from './id-migration'
import { EPISODE_ID_RE_LOOSE } from './episode-id'
import { renderBookingInfo, bookingInfoInput } from './booking-info'

const SHOOT_FILE_RE = /^_SHOOT.*\.txt$/i
const CANONICAL_MARKER = '_SHOOT.txt'

/** Normalize any Production ID to its current typeless canonical (drops [TYPE]). */
function normalizeCode(id: string): string {
  return (computeTypeDroppedId(id) ?? id).trim().toUpperCase()
}

/**
 * v1.146 review fix — resolve a marker's Production ID against the box's live
 * booking codes, checking the RAW id BEFORE normalizing. The v1.109 migration
 * deliberately left the 4 collision-pair bookings on their legacy [TYPE] codes
 * (e.g. AGN-260703-STD-01 is a LIVE bookingCode); normalizing first dropped
 * the [TYPE], matched nothing, and the live booking's marker got trashed as
 * stale. Mirrors the raw-vs-normalized handling the folder-drift warning uses.
 */
export function resolveMarkerCode(parsedId: string, liveCodes: string[]): string {
  const raw = parsedId.trim().toUpperCase()
  if (liveCodes.includes(raw)) return raw
  return normalizeCode(parsedId)
}

/** Pull a Production ID out of a box-level marker filename "_SHOOT-<id>.txt". */
export function idFromMarkerName(name: string): string | null {
  const m = name.match(/^_SHOOT-(.+)\.txt$/i)
  if (!m) return null
  const loose = m[1].match(EPISODE_ID_RE_LOOSE)
  return loose ? loose[1] : m[1].trim()
}

/** Pull the Production ID out of a marker's CONTENT ("Production ID     : AGN-…"). */
export function parseMarkerProductionId(text: string): string | null {
  // the label is padded then ':'; accept any spacing, ASCII/Thai label variants.
  const m = text.match(/Production ID\s*:\s*([A-Za-z0-9-]+)/)
  return m ? m[1].trim() : null
}

/**
 * True when a marker's date line carries a Buddhist-era year (≥ 2500) — the
 * pre-v1.134 `th-TH` bug rendered `2 ก.ค. 2569` (or the double-converted `3112`).
 * A correct Gregorian marker has 20xx, so any 25xx/31xx on the "วันที่ / Date"
 * line means the marker predates the fix and should be rewritten.
 */
export function markerDateHasBuddhistYear(text: string): boolean {
  for (const line of text.split('\n')) {
    if (!/วันที่|Date/i.test(line)) continue
    for (const y of line.match(/\b(\d{4})\b/g) || []) {
      if (parseInt(y, 10) >= 2500) return true
    }
  }
  return false
}

type BookingFull = {
  bookingCode: string | null
  status: string
  projectId: string | null
  projectName: string | null
  category: string | null
  videoType: string | null
  shootType: string | null
  shootDate: Date
  shootEndDate: Date | null
  callTime: string | null
  estimatedWrap: string | null
  locationName: string | null
  producer: string | null
  producerEmail: string | null
  director: string | null
  directorEmail: string | null
  mainVideographerEmail: string | null
  assignedEmails: string[]
  crewRequired: string[]
  agencyRef: string | null
  notes: string | null
  outlet: { name: string; code: string }
  episodes: Array<{ episodeId: string; title: string | null; sequence: number }>
}

export interface ShootMarkerReconcileResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  scannedProjects: number
  scannedBookings: number
  fixed: {
    duplicatesTrashed: number
    staleTrashed: number
    movedIntoBooking: number
    dedupedInSubfolder: number
    contentRewritten: number
    markersCreated: number
  }
  /** Human-attention items the worker did NOT auto-fix (folder rename, ambiguous, orphan). */
  warnings: string[]
  errors: number
  details: Array<{
    projectId: string
    box?: string
    boxUrl?: string
    skipped?: string
    actions?: string[]
  }>
}

function emptyFixed(): ShootMarkerReconcileResult['fixed'] {
  return { duplicatesTrashed: 0, staleTrashed: 0, movedIntoBooking: 0, dedupedInSubfolder: 0, contentRewritten: 0, markersCreated: 0 }
}

export function totalChanges(r: ShootMarkerReconcileResult): number {
  const f = r.fixed
  return f.duplicatesTrashed + f.staleTrashed + f.movedIntoBooking + f.dedupedInSubfolder + f.contentRewritten + f.markersCreated
}

export async function reconcileShootMarkers(
  opts: { dryRun?: boolean; projectId?: string; limitProjects?: number } = {},
): Promise<ShootMarkerReconcileResult> {
  const dryRun = !!opts.dryRun
  const base: ShootMarkerReconcileResult = {
    skipped: false, dryRun, scannedProjects: 0, scannedBookings: 0,
    fixed: emptyFixed(), warnings: [], errors: 0, details: [],
  }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { ...base, skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials' }
  }

  // AGN project bookings — the only layout with a shared box + sibling markers.
  // Full field set so a drifted marker can be regenerated verbatim from the DB.
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
      videoType: true, shootType: true, shootDate: true, shootEndDate: true,
      callTime: true, estimatedWrap: true, locationName: true,
      producer: true, producerEmail: true, director: true, directorEmail: true,
      mainVideographerEmail: true, assignedEmails: true, crewRequired: true,
      agencyRef: true, notes: true,
      outlet: { select: { name: true, code: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, title: true, sequence: true } },
    },
  })

  const byProject = new Map<string, BookingFull[]>()
  for (const b of bookings as unknown as BookingFull[]) {
    const g = byProject.get(b.projectId!) || []
    g.push(b)
    byProject.set(b.projectId!, g)
  }

  const markerContent = (b: BookingFull): string => renderBookingInfo(bookingInfoInput(b))

  const canon = outletDriveFolderName('AGN')
  let projectsSeen = 0
  for (const [projectId, group] of Array.from(byProject)) {
    if (opts.limitProjects && projectsSeen >= opts.limitProjects) break
    projectsSeen++
    base.scannedProjects++
    base.scannedBookings += group.length
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
      if (!boxId) { base.details.push({ projectId, skipped: 'project box not found on Drive' }); continue }

      const bookingByCode = new Map(group.map(b => [b.bookingCode!.toUpperCase(), b]))
      const codes = Array.from(bookingByCode.keys())
      const kids = await listChildFolders(boxId)

      // Per-booking subfolder (matched by code) → { id, hasCanonical }. Also
      // collapse duplicate `_SHOOT.txt` inside each so "hasCanonical" means one.
      const subByCode = new Map<string, { id: string; hasCanonical: boolean }>()
      for (const code of codes) {
        const kid = kids.find(k => folderNameMatchesCode(k.name, code))
        if (!kid) continue
        const dd = await dedupeShootInfoFiles(kid.id, { dryRun })
        if (dd.totalTrashed > 0) {
          base.fixed.dedupedInSubfolder += dd.totalTrashed
          actions.push(`dedupe "${kid.name}": trashed ${dd.totalTrashed} duplicate _SHOOT.txt`)
        }
        const files = await listFilesInFolder(kid.id)
        const hasCanonical = files.some(f => SHOOT_FILE_RE.test(f.name))
        subByCode.set(code, { id: kid.id, hasCanonical })
      }

      // Folder-name drift (subfolder embeds a legacy [TYPE] id) → warn, don't rename.
      for (const kid of kids) {
        const m = kid.name.match(/\(([A-Z0-9-]+)\)\s*$/i)
        if (!m) continue
        const embedded = m[1].toUpperCase()
        const normalized = normalizeCode(embedded)
        if (embedded !== normalized && codes.includes(normalized)) {
          base.warnings.push(`โฟลเดอร์ชื่อยังมี TYPE: "${kid.name}" (ควรเป็น ${normalized}) — box ${boxName}`)
        }
      }

      // Box-LEVEL markers — the pre-v1.112 leftovers that duplicate the shoot.
      const boxFiles = await listFilesInFolder(boxId)
      for (const f of boxFiles) {
        if (!SHOOT_FILE_RE.test(f.name)) continue
        const parsedId = idFromMarkerName(f.name)
        if (!parsedId) {
          base.warnings.push(`box-level "${f.name}" ไม่มี Production ID ในชื่อ — box ${boxName} (ไม่แตะ)`)
          continue
        }
        const code = resolveMarkerCode(parsedId, codes)
        const sub = codes.includes(code) ? subByCode.get(code) : undefined

        if (!codes.includes(code)) {
          actions.push(`trash STALE box-level "${f.name}" (no live booking ${code})`)
          if (!dryRun) {
            try { await trashDriveItem(f.id) } catch (e: any) { base.errors++; actions.push(`  ERROR trash: ${e?.message || e}`); continue }
          }
          base.fixed.staleTrashed++
        } else if (sub && sub.hasCanonical) {
          actions.push(`trash DUPLICATE box-level "${f.name}" (canonical exists for ${code})`)
          if (!dryRun) {
            try { await trashDriveItem(f.id) } catch (e: any) { base.errors++; actions.push(`  ERROR trash: ${e?.message || e}`); continue }
          }
          base.fixed.duplicatesTrashed++
        } else if (sub && !sub.hasCanonical) {
          actions.push(`move box-level "${f.name}" → booking folder as _SHOOT.txt (${code})`)
          if (!dryRun) {
            try {
              await moveFileToFolder(f.id, sub.id, boxId)
              await renameDriveItem(f.id, CANONICAL_MARKER)
            } catch (e: any) { base.errors++; actions.push(`  ERROR move: ${e?.message || e}`); continue }
          }
          sub.hasCanonical = true
          base.fixed.movedIntoBooking++
        } else {
          base.warnings.push(`box-level "${f.name}" (${code}) ยังไม่มี booking subfolder — box ${boxName} (คงไว้)`)
        }
      }

      // CONTENT audit — every booking with a subfolder: the canonical marker's
      // Production ID + date must match the DB, else rewrite from the DB.
      for (const code of codes) {
        const sub = subByCode.get(code)
        const bk = bookingByCode.get(code)!
        if (!sub) continue
        const isLive = bk.status === 'CONFIRMED' || bk.status === 'COMPLETED'
        if (!sub.hasCanonical) {
          if (isLive) {
            actions.push(`create MISSING _SHOOT.txt for ${code}`)
            if (!dryRun) {
              try { await upsertTextFile({ parentFolderId: sub.id, name: CANONICAL_MARKER, content: markerContent(bk) }) }
              catch (e: any) { base.errors++; actions.push(`  ERROR create: ${e?.message || e}`); continue }
            }
            base.fixed.markersCreated++
          }
          continue
        }
        // read the existing canonical marker + verify content
        let drift: string | null = null
        try {
          const files = await listFilesInFolder(sub.id)
          const marker = files.find(fx => fx.name.toLowerCase() === CANONICAL_MARKER.toLowerCase())
            || files.find(fx => SHOOT_FILE_RE.test(fx.name))
          if (!marker) continue
          const text = await readDriveTextFile(marker.id)
          const pid = parseMarkerProductionId(text)
          if (!pid || pid.toUpperCase() !== code) drift = `Production ID "${pid ?? '—'}" ≠ ${code}`
          else if (markerDateHasBuddhistYear(text)) drift = 'วันที่เป็นปีพุทธ (ต้องเป็น ค.ศ.)'
        } catch (e: any) {
          base.warnings.push(`อ่าน marker ของ ${code} ไม่ได้: ${e?.message || e} — box ${boxName}`)
          continue
        }
        if (drift) {
          actions.push(`rewrite _SHOOT.txt for ${code} — ${drift}`)
          if (!dryRun) {
            try { await upsertTextFile({ parentFolderId: sub.id, name: CANONICAL_MARKER, content: markerContent(bk) }) }
            catch (e: any) { base.errors++; actions.push(`  ERROR rewrite: ${e?.message || e}`); continue }
          }
          base.fixed.contentRewritten++
        }
      }

      base.details.push({
        projectId, box: boxName,
        boxUrl: `https://drive.google.com/drive/folders/${boxId}`,
        actions,
      })
    } catch (e: any) {
      base.errors++
      base.details.push({ projectId, skipped: `error: ${e?.message || String(e)}`, actions })
    }
  }

  return base
}

/** Human-readable digest for the nightly report email. */
export function formatReconcileReport(r: ShootMarkerReconcileResult): { subject: string; text: string } {
  if (r.skipped) {
    return { subject: '[Footage] marker reconcile — skipped', text: `ข้ามการทำงาน: ${r.reason}` }
  }
  const f = r.fixed
  const changes = totalChanges(r)
  const head = r.dryRun ? '[Footage] marker reconcile (DRY-RUN)' : '[Footage] marker reconcile'
  const subject = `${head} — แก้ ${changes} · เตือน ${r.warnings.length}${r.errors ? ` · error ${r.errors}` : ''}`

  const lines: string[] = []
  lines.push(`สแกน ${r.scannedProjects} โปรเจกต์ · ${r.scannedBookings} booking (AGN)`)
  lines.push('')
  lines.push('── แก้อัตโนมัติ ─────────────────')
  lines.push(`ลบมาร์กเกอร์ซ้ำ (box-level)   : ${f.duplicatesTrashed}`)
  lines.push(`ลบมาร์กเกอร์ค้าง (stale)      : ${f.staleTrashed}`)
  lines.push(`ย้ายเข้า booking folder       : ${f.movedIntoBooking}`)
  lines.push(`dedupe _SHOOT.txt ในโฟลเดอร์  : ${f.dedupedInSubfolder}`)
  lines.push(`เขียนเนื้อ marker ใหม่ (ID/วันที่): ${f.contentRewritten}`)
  lines.push(`สร้าง marker ที่หาย           : ${f.markersCreated}`)

  if (r.warnings.length) {
    lines.push('')
    lines.push(`── ต้องดูเอง (${r.warnings.length}) ─────────────`)
    for (const w of r.warnings.slice(0, 50)) lines.push(`• ${w}`)
    if (r.warnings.length > 50) lines.push(`… และอีก ${r.warnings.length - 50} รายการ`)
  }

  const detailWithActions = r.details.filter(d => (d.actions && d.actions.length) || d.skipped)
  if (detailWithActions.length) {
    lines.push('')
    lines.push('── รายละเอียดต่อ box ─────────────')
    for (const d of detailWithActions.slice(0, 40)) {
      lines.push(`▸ ${d.box || d.projectId}${d.boxUrl ? ` (${d.boxUrl})` : ''}`)
      if (d.skipped) lines.push(`    skipped: ${d.skipped}`)
      for (const a of d.actions || []) lines.push(`    - ${a}`)
    }
  }

  if (r.errors) { lines.push(''); lines.push(`⚠ errors: ${r.errors}`) }
  return { subject, text: lines.join('\n') }
}
