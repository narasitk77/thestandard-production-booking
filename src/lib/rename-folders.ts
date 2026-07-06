/**
 * v1.110 — one-off: rename existing Drive folders from the legacy "<code> · <job>"
 * shape to the show-first "<show> · <job> (<code>)" shape (job cleaned of the van/
 * logistics parenthetical). Covers the per-booking VIDEO box (non-AGN), the flat
 * Production Team landing, the sound-staging folder, and the photo-album folder.
 * The AGN project box (shared, projectId-keyed) is intentionally left alone.
 *
 * BULK + fast: each relevant parent (the 3 flat roots + each distinct program
 * folder) is listed ONCE and its children matched to bookings by Production ID in
 * memory — no per-booking Drive tree walk (which timed out on the full set). Each
 * folder is renamed ONLY if its current name differs from the target, so re-running
 * is a no-op. dryRun reports every "old → new" without touching Drive.
 */
import { prisma } from './db'
import {
  listChildFolders, findChildFolder, findProgramFolderId, renameDriveItem,
  hasDriveCredentials, DRIVE_PHOTO_ROOT, SOUND_STAGING_DIR, listSoundStagingBookingFolders,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildBookingFolderName,
  landingBookingFolderName, folderNameMatchesCode, isPhotoAlbumBooking,
} from './outlet-folders'
import { bookingShowName } from './display'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

export interface FolderRenameResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  bookings: number
  renamed: number
  alreadyOk: number
  errors: number
  results: Array<{ bookingCode: string | null; changes?: string[]; error?: string }>
}

type Meta = {
  code: string
  jobName: string | null
  showName: string
  // v1.111 — crew-facing landing name (display show, "-" job dropped); the
  // landing pool renames toward this, NOT the box-style newFlatName.
  landingName: string
  isAgency: boolean
  isPhoto: boolean
  outletCode: string
  category: string | null
  projectId: string | null
  projectName: string | null
}

export async function runFolderRename(opts: { dryRun?: boolean } = {}): Promise<FolderRenameResult> {
  const base = { dryRun: !!opts.dryRun, bookings: 0, renamed: 0, alreadyOk: 0, errors: 0, results: [] as FolderRenameResult['results'] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', ...base }

  const bookings = await prisma.booking.findMany({
    where: { bookingCode: { not: null } },
    select: {
      bookingCode: true, projectId: true, projectName: true, category: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { code: true, name: true } } } },
    },
  })
  const metas: Meta[] = bookings.map(b => ({
    code: b.bookingCode!,
    jobName: b.projectName?.trim() || b.episodes[0]?.title?.trim() || null,
    showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
    landingName: landingBookingFolderName({ bookingCode: b.bookingCode!, projectName: b.projectName, program: b.program, episodes: b.episodes }),
    isAgency: b.outlet.code === 'AGN',
    isPhoto: isPhotoAlbumBooking(b.episodes),
    outletCode: b.outlet.code,
    category: b.category,
    projectId: b.projectId,
    projectName: b.projectName,
  }))
  base.bookings = metas.length

  const changesByCode = new Map<string, string[]>()
  const rememberChange = (code: string, s: string) => {
    const a = changesByCode.get(code) || []
    a.push(s)
    changesByCode.set(code, a)
  }
  // Rename only when the CURRENT name (known from the bulk listing) differs.
  const renameIfDiff = async (id: string, curName: string, newName: string, code: string, label: string) => {
    if (curName === newName) { base.alreadyOk++; return }
    rememberChange(code, `${label}: "${curName}" → "${newName}"`)
    if (base.dryRun) { base.renamed++; return }
    try { await renameDriveItem(id, newName); base.renamed++ }
    catch (e: any) { base.errors++; rememberChange(code, `${label}: ERROR ${e?.message || e}`) }
  }
  const newFlatName = (m: Meta) => buildBookingFolderName(m.code, m.jobName, m.showName)

  try {
    // (A) flat parents — list once, match children to bookings by Production ID.
    const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
    const flatParents: Array<{ id: string | null; label: string; pool: Meta[] }> = [
      { id: PRODUCTION_TEAM_ROOT, label: 'landing', pool: metas },
      { id: DRIVE_PHOTO_ROOT, label: 'photo', pool: metas.filter(m => m.isPhoto) },
      { id: stagingRoot, label: 'sound', pool: metas },
    ]
    for (const fp of flatParents) {
      if (!fp.id) continue
      // v1.123 — sound staging is nested by show category; walk both shapes.
      const children = fp.label === 'sound' ? await listSoundStagingBookingFolders(fp.id) : await listChildFolders(fp.id)
      for (const child of children) {
        const m = fp.pool.find(x => folderNameMatchesCode(child.name, x.code))
        // v1.111 — landing AND sound-staging are crew-facing → display name;
        // photo keeps the box-style name.
        if (m) await renameIfDiff(child.id, child.name, fp.label === 'photo' ? newFlatName(m) : m.landingName, m.code, fp.label)
      }
    }

    // (B) VIDEO boxes — group non-AGN, non-photo bookings by their program folder,
    //     list each program folder once, match boxes by Production ID.
    const groups = new Map<string, { outletCanon: string; programFolderName: string; items: Meta[] }>()
    for (const m of metas) {
      if (m.isAgency || m.isPhoto) continue
      const { programFolderName } = shootFolderLayers({
        outletCode: m.outletCode, showName: m.showName, category: m.category,
        projectId: m.projectId, projectName: m.projectName, bookingCode: m.code, jobName: m.jobName,
      })
      const outletCanon = outletDriveFolderName(m.outletCode)
      const key = `${outletCanon}||${programFolderName}`
      const g = groups.get(key) || { outletCanon, programFolderName, items: [] }
      g.items.push(m)
      groups.set(key, g)
    }
    for (const g of Array.from(groups.values())) {
      const programId = await findProgramFolderId(root, g.outletCanon, g.programFolderName)
      if (!programId) continue
      const children = await listChildFolders(programId)
      for (const m of g.items) {
        const child = children.find(c => folderNameMatchesCode(c.name, m.code))
        if (child) await renameIfDiff(child.id, child.name, newFlatName(m), m.code, 'box')
      }
    }

    for (const [code, ch] of Array.from(changesByCode)) base.results.push({ bookingCode: code, changes: ch })
  } catch (e: any) {
    base.errors++
    base.results.push({ bookingCode: null, error: e?.message || String(e) })
  }

  return { skipped: false, ...base }
}
