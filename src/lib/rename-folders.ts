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
// v1.157 — id-first: stored Drive links match children by ID (rename-proof);
// names are the fallback. Renames stay gated on isAppShapedName so a name ops
// deliberately set (code stripped) is never touched — it is REPORTED instead
// of silently skipped like before.
import { getDriveLink, rememberDriveLinks, type DriveLinkKey } from './drive-links'
import { noteResolve } from './id-first-metrics'
import { isAppShapedName } from './folder-integrity'

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
  bookingId: string
  driveFolders: unknown
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
      id: true, driveFolders: true, // v1.157 — id-first matching + self-heal
      bookingCode: true, projectId: true, projectName: true, category: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { code: true, name: true } } } },
    },
  })
  const metas: Meta[] = bookings.map(b => ({
    bookingId: b.id,
    driveFolders: b.driveFolders,
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
    const linkKeyOf: Record<string, DriveLinkKey> = { landing: 'landing', photo: 'photo', sound: 'staging' }
    for (const fp of flatParents) {
      if (!fp.id) continue
      // v1.123 — sound staging is nested by show category; walk both shapes.
      const children = fp.label === 'sound' ? await listSoundStagingBookingFolders(fp.id) : await listChildFolders(fp.id)
      // v1.157 — id-first: index the pool by stored folder id so a child whose
      // display name lost its code still maps to its booking.
      const linkKey = linkKeyOf[fp.label]
      const byStoredId = new Map<string, Meta>()
      for (const m of fp.pool) {
        const lid = getDriveLink(m.driveFolders, linkKey)
        if (lid) byStoredId.set(lid, m)
      }
      const childIds = new Set(children.map(c => c.id))
      for (const child of children) {
        const viaStored = byStoredId.has(child.id)
        const m = byStoredId.get(child.id) ?? fp.pool.find(x => folderNameMatchesCode(child.name, x.code))
        if (!m) continue
        // v1.157 review fix — a name-matching child while the booking's REAL
        // folder (its live stored id) is ALSO in this parent = a duplicate.
        // Touching it would rename it into a same-name twin, and healing would
        // steal the stored link from the real folder. Skip it entirely (the
        // landing-dedup sweep owns duplicate cleanup).
        if (!viaStored) {
          const cur = getDriveLink(m.driveFolders, linkKey)
          if (cur && cur !== child.id && childIds.has(cur)) {
            rememberChange(m.code, `${fp.label}: ข้าม "${child.name}" — น่าจะเป็นโฟลเดอร์ซ้ำ (ตัวจริงของงานนี้อยู่ในโฟลเดอร์นี้แล้ว)`)
            continue
          }
        }
        noteResolve('rename-folders', fp.label, m.code, viaStored)
        // Never fight a name ops set on purpose: report, don't rename. NOTE the
        // gates differ — folderNameMatchesCode accepts "(CODE)" anywhere, but
        // isAppShapedName needs it end-anchored, so a name CAN carry the code
        // yet fail here (e.g. Drive copy artifact "… (CODE) (1)"). Report which.
        if (!isAppShapedName(child.name, m.code)) {
          rememberChange(m.code, folderNameMatchesCode(child.name, m.code)
            ? `${fp.label}: ข้าม "${child.name}" — มีรหัสงานแต่รูปแบบชื่อไม่ใช่ของระบบ (ไม่แตะ)`
            : `${fp.label}: ข้าม "${child.name}" — ชื่อถูกตั้งเอง (ไม่มีรหัสงานท้ายชื่อ) ไม่แตะ`)
          continue
        }
        // Heal AFTER the gates so a skipped folder can never capture the link.
        if (!viaStored && !base.dryRun) await rememberDriveLinks(m.bookingId, { [linkKey]: child.id })
        // v1.111 — landing AND sound-staging are crew-facing → display name;
        // photo keeps the box-style name.
        await renameIfDiff(child.id, child.name, fp.label === 'photo' ? newFlatName(m) : m.landingName, m.code, fp.label)
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
        // v1.157 — id-first: stored box id wins when it is a child of this
        // program folder (rename-proof); the code match is the fallback.
        const storedBox = getDriveLink(m.driveFolders, 'box')
        const viaStored = !!storedBox && children.some(c => c.id === storedBox)
        const child = (viaStored ? children.find(c => c.id === storedBox) : undefined)
          ?? children.find(c => folderNameMatchesCode(c.name, m.code))
        if (!child) continue
        noteResolve('rename-folders', 'box', m.code, viaStored)
        if (!viaStored && !base.dryRun) await rememberDriveLinks(m.bookingId, { box: child.id })
        if (!isAppShapedName(child.name, m.code)) {
          rememberChange(m.code, folderNameMatchesCode(child.name, m.code)
            ? `box: ข้าม "${child.name}" — มีรหัสงานแต่รูปแบบชื่อไม่ใช่ของระบบ (ไม่แตะ)`
            : `box: ข้าม "${child.name}" — ชื่อถูกตั้งเอง (ไม่มีรหัสงานท้ายชื่อ) ไม่แตะ`)
          continue
        }
        await renameIfDiff(child.id, child.name, newFlatName(m), m.code, 'box')
      }
    }

    for (const [code, ch] of Array.from(changesByCode)) base.results.push({ bookingCode: code, changes: ch })
  } catch (e: any) {
    base.errors++
    base.results.push({ bookingCode: null, error: e?.message || String(e) })
  }

  return { skipped: false, ...base }
}
