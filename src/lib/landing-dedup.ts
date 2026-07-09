/**
 * Landing-folder de-duplicator (v1.138).
 *
 * The "Production Team" landing drive holds one flat drop folder per shoot,
 * "<show · job> (<Production ID>)". A concurrent double-run of the prep-folders
 * catch-up (or any race) can create the SAME shoot's drop folder twice, so crew
 * see two identical folders and don't know which to use. This pass keeps exactly
 * ONE folder per Production ID and trashes the EMPTY duplicate shells.
 *
 * Hard safety: a folder that holds any REAL file (anything but a `_SHOOT` stub,
 * anywhere inside) is NEVER trashed — if two same-code folders both have footage,
 * both are kept and the collision is reported for a human. Only regenerable empty
 * shells go to Shared-Drive trash (recoverable ~30 days). Fast: one root listing
 * plus a recursive check only for the (few) folders that share a code. dry-run first.
 */
import { prisma } from './db'
import { listChildFolders, listFilesRecursive, trashDriveItem, hasDriveCredentials } from './google-drive'
import { computeTypeDroppedId } from './id-migration'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'
const SHOOT_STUB_RE = /^_SHOOT\b.*\.txt$/i

/** Pull the Production ID out of a landing folder name "… (AGN-260708-01)". */
function codeFromFolderName(name: string): string | null {
  const m = name.match(/\(([A-Za-z0-9-]+)\)\s*$/)
  if (!m) return null
  const raw = m[1]
  return (computeTypeDroppedId(raw) ?? raw).toUpperCase()
}

async function hasRealFiles(folderId: string): Promise<boolean> {
  const files = await listFilesRecursive(folderId, { maxFiles: 6 })
  return files.some(f => !SHOOT_STUB_RE.test(f.name))
}

export interface LandingDedupResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  groupsWithDuplicates: number
  trashed: number
  keptWithFiles: number
  collisions: string[] // same code, 2+ folders WITH files — left for a human
  errors: number
  actions: string[]
}

export async function dedupeLandingFolders(opts: { dryRun?: boolean } = {}): Promise<LandingDedupResult> {
  const dryRun = !!opts.dryRun
  const base: LandingDedupResult = { skipped: false, dryRun, groupsWithDuplicates: 0, trashed: 0, keptWithFiles: 0, collisions: [], errors: 0, actions: [] }
  if (!hasDriveCredentials()) return { ...base, skipped: true, reason: 'no Drive credentials' }

  const kids = await listChildFolders(PRODUCTION_TEAM_ROOT)

  // group by normalized Production ID
  const byCode = new Map<string, Array<{ id: string; name: string }>>()
  for (const k of kids) {
    const code = codeFromFolderName(k.name)
    if (!code) continue
    const g = byCode.get(code) || []
    g.push(k)
    byCode.set(code, g)
  }

  // to prefer keeping the folder the app already links to
  const linkedIds = new Set<string>()
  try {
    const rows = await prisma.booking.findMany({ where: { deletedAt: null }, select: { driveFolders: true } })
    for (const r of rows) {
      const lid = (r.driveFolders as any)?.landing
      if (typeof lid === 'string' && lid) linkedIds.add(lid)
    }
  } catch { /* best-effort */ }

  for (const [code, folders] of Array.from(byCode)) {
    if (folders.length < 2) continue
    base.groupsWithDuplicates++

    // classify each: does it hold real footage?
    const withFiles: typeof folders = []
    const emptyShells: typeof folders = []
    for (const f of folders) {
      try { (await hasRealFiles(f.id) ? withFiles : emptyShells).push(f) }
      catch (e: any) { base.errors++; base.actions.push(`ERROR check "${f.name}": ${e?.message || e}`); withFiles.push(f) /* be safe — treat as non-empty */ }
    }

    if (withFiles.length >= 2) {
      // Two real footage folders for one shoot — never auto-trash; a human must merge.
      base.collisions.push(`${code}: ${withFiles.length} โฟลเดอร์มีไฟล์ (ต้องรวมเอง) — ${withFiles.map(f => f.name).join(' · ')}`)
      continue
    }

    // keep: the one with files, else the app-linked one, else the first.
    const keep = withFiles[0]
      || emptyShells.find(f => linkedIds.has(f.id))
      || emptyShells[0]
    if (withFiles.length === 1) base.keptWithFiles++
    const toTrash = folders.filter(f => f.id !== keep.id && !withFiles.includes(f))
    for (const t of toTrash) {
      base.actions.push(`trash duplicate empty landing "${t.name}" (keep "${keep.name}")`)
      if (!dryRun) {
        try { await trashDriveItem(t.id); base.trashed++ }
        catch (e: any) { base.errors++; base.actions.push(`  ERROR trash: ${e?.message || e}`) }
      } else base.trashed++
    }
  }

  return base
}
