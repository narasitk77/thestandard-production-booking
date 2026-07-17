/**
 * v1.148 — Footage bundle: link a shoot done on a different day into the SAME
 * job's Drive box (e.g. an interview insert shot 18-07 for a program shot
 * 01-08). Each shoot stays its own booking (own call time / crew / OT /
 * calendar chip — no multi-day drag); ONLY the footage destination is shared.
 *
 * Mechanic (id-first, near-zero downstream change): every footage consumer
 * (detect / video-merge / sound-merge / notify-ready / footage-ready / upload)
 * resolves a booking's box by its stored `driveFolders.box` id FIRST
 * (footage-folders.ts:70). So linking = REPARENT the child's whole box folder
 * to sit inside the home booking's box; the child's box id is unchanged, so
 * all its detection/merge keeps working — the files just physically live under
 * the home box now. Walking the home box (parent's notify) sees the child too.
 *
 * Scope (v1): NON-AGN, non-photo bookings. AGN already shares one project box
 * per projectId, so AGN inserts of the same project land together with no link.
 */
import { prisma } from './db'
import { logAudit } from './audit'
import {
  ensureShootCameraFolders, ensureProgramPath, moveFileToFolder, getDriveParentFolderId,
  isFolderAlive, hasDriveCredentials,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, camerasToPreCreate, isPhotoAlbumBooking,
} from './outlet-folders'
import { bookingShowName } from './display'
import { getDriveLink, rememberDriveLinks } from './drive-links'

export type BundleBooking = {
  id: string
  bookingCode: string | null
  deletedAt: Date | null
  cameraCount: number | null
  projectId: string | null
  projectName: string | null
  category: string | null
  driveFolders: unknown
  bundleParentId: string | null
  outlet: { code: string }
  program: { name: string }
  episodes: Array<{ episodeId: string | null; sequence: number; title: string | null; program: { code: string; name: string } | null }>
}

const SELECT = {
  id: true, bookingCode: true, deletedAt: true, cameraCount: true,
  projectId: true, projectName: true, category: true, driveFolders: true, bundleParentId: true,
  outlet: { select: { code: true } },
  program: { select: { name: true } },
  episodes: { orderBy: { sequence: 'asc' as const }, select: { episodeId: true, sequence: true, title: true, program: { select: { code: true, name: true } } } },
}

// ── Pure validation (unit-tested) ───────────────────────────────────────────

export function validateBundleLink(
  child: Pick<BundleBooking, 'id' | 'bookingCode' | 'deletedAt' | 'outlet' | 'episodes'>,
  parent: Pick<BundleBooking, 'id' | 'bookingCode' | 'deletedAt' | 'outlet' | 'episodes' | 'bundleParentId'>,
  childChildCount: number, // how many bookings already fold into the CHILD (must be 0)
): { ok: true } | { ok: false; error: string } {
  if (child.id === parent.id) return { ok: false, error: 'ผูกงานเข้ากับตัวเองไม่ได้' }
  if (child.deletedAt) return { ok: false, error: 'งานที่จะผูกถูกลบไปแล้ว' }
  if (parent.deletedAt) return { ok: false, error: 'งานหลักถูกลบไปแล้ว' }
  if (!child.bookingCode || !parent.bookingCode) return { ok: false, error: 'ต้องมี Production ID ทั้งสองงานก่อนผูก' }
  if (child.outlet.code === 'AGN' || parent.outlet.code === 'AGN') {
    return { ok: false, error: 'AGN ใช้ Project box ร่วมกันอยู่แล้ว (ตาม projectId) — ไม่ต้องผูก bundle' }
  }
  if (isPhotoAlbumBooking(child.episodes) || isPhotoAlbumBooking(parent.episodes)) {
    return { ok: false, error: 'งาน Photo Album อยู่คนละ Drive — ผูก bundle ไม่ได้' }
  }
  // One level only: the home must itself be a root (not already someone's child),
  // else footage would nest confusingly two levels deep.
  if (parent.bundleParentId) {
    return { ok: false, error: `งานหลักที่เลือก (${parent.bookingCode}) เองก็อยู่ในชุดอื่นแล้ว — เลือกงานหลักตัวจริง` }
  }
  // And the child must not itself already be a home to other bookings.
  if (childChildCount > 0) {
    return { ok: false, error: `งานนี้ (${child.bookingCode}) เป็นงานหลักของชุดอยู่แล้ว — แยกลูกออกก่อนจึงจะเอาไปเป็นลูกงานอื่นได้` }
  }
  return { ok: true }
}

// ── Box resolution ──────────────────────────────────────────────────────────

/**
 * Ensure a (non-AGN) booking's Drive box exists and return its id. Prefers the
 * stored driveFolders.box when it's still alive (id-first); otherwise creates
 * it at the canonical outlet/program path (idempotent — same primitive prep uses).
 */
async function ensureBookingBoxId(b: BundleBooking, root: string): Promise<string> {
  const stored = getDriveLink(b.driveFolders, 'box')
  if (stored && await isFolderAlive(stored)) return stored

  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const layers = shootFolderLayers({
    outletCode: b.outlet.code,
    showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
    category: b.category,
    projectId: b.projectId,
    projectName: b.projectName,
    bookingCode: b.bookingCode!,
    jobName,
  })
  const episodeFolderNames = b.episodes.length ? b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: false })) : undefined
  const { bookingFolderId } = await ensureShootCameraFolders({
    rootFolderId: root,
    outletCanonicalName: outletDriveFolderName(b.outlet.code),
    programFolderName: layers.programFolderName,
    bookingFolderName: layers.bookingFolderName,
    bookingCode: b.bookingCode!,
    cameras: camerasToPreCreate(b.cameraCount),
    episodeFolderNames,
  })
  await rememberDriveLinks(b.id, { box: bookingFolderId })
  return bookingFolderId
}

async function canonicalProgramFolderId(b: BundleBooking, root: string): Promise<string> {
  const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const layers = shootFolderLayers({
    outletCode: b.outlet.code,
    showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
    category: b.category, projectId: b.projectId, projectName: b.projectName, bookingCode: b.bookingCode!, jobName,
  })
  return ensureProgramPath(root, outletDriveFolderName(b.outlet.code), layers.programFolderName)
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type BundleResult = {
  ok: boolean
  childCode: string | null
  parentCode: string | null
  childBoxId?: string
  parentBoxId?: string
  moved?: boolean
  error?: string
}

/** Link `childId`'s footage box into `parentId`'s box. */
export async function linkBookingBundle(childId: string, parentId: string, actorEmail: string): Promise<BundleResult> {
  if (!hasDriveCredentials()) return { ok: false, childCode: null, parentCode: null, error: 'Drive ยังไม่ได้ตั้งค่า credentials' }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root) return { ok: false, childCode: null, parentCode: null, error: 'ยังไม่ได้ตั้งค่า DRIVE_FOOTAGE_ROOT' }

  const [child, parent, childChildCount] = await Promise.all([
    prisma.booking.findUnique({ where: { id: childId }, select: SELECT }) as unknown as Promise<BundleBooking | null>,
    prisma.booking.findUnique({ where: { id: parentId }, select: SELECT }) as unknown as Promise<BundleBooking | null>,
    prisma.booking.count({ where: { bundleParentId: childId } }),
  ])
  if (!child) return { ok: false, childCode: null, parentCode: null, error: 'ไม่พบงานที่จะผูก' }
  if (!parent) return { ok: false, childCode: child.bookingCode, parentCode: null, error: 'ไม่พบงานหลัก' }

  const v = validateBundleLink(child, parent, childChildCount)
  if (!v.ok) return { ok: false, childCode: child.bookingCode, parentCode: parent.bookingCode, error: v.error }

  const parentBoxId = await ensureBookingBoxId(parent, root)
  const childBoxId = await ensureBookingBoxId(child, root)
  if (childBoxId === parentBoxId) {
    return { ok: false, childCode: child.bookingCode, parentCode: parent.bookingCode, error: 'สองงานชี้กล่องเดียวกันอยู่แล้ว — ตรวจสอบก่อน' }
  }

  const currentParent = await getDriveParentFolderId(childBoxId)
  let moved = false
  if (currentParent !== parentBoxId) {
    if (!currentParent) return { ok: false, childCode: child.bookingCode, parentCode: parent.bookingCode, error: 'หา parent เดิมของกล่องไม่เจอ — ยกเลิก' }
    await moveFileToFolder(childBoxId, parentBoxId, currentParent)
    moved = true
  }
  // Box id is unchanged — just make sure it's persisted, then set the link.
  await rememberDriveLinks(child.id, { box: childBoxId })
  await prisma.booking.update({ where: { id: child.id }, data: { bundleParentId: parent.id } })

  logAudit({
    actorEmail, action: 'booking.bundle_link', entityType: 'Booking', entityId: child.id,
    bookingCode: child.bookingCode,
    changes: { parentId: parent.id, parentCode: parent.bookingCode, childBoxId, parentBoxId, moved },
  })
  return { ok: true, childCode: child.bookingCode, parentCode: parent.bookingCode, childBoxId, parentBoxId, moved }
}

/** Unlink `childId` — move its box back to the canonical location + clear the link. */
export async function unlinkBookingBundle(childId: string, actorEmail: string): Promise<BundleResult> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  const child = await prisma.booking.findUnique({ where: { id: childId }, select: SELECT }) as unknown as BundleBooking | null
  if (!child) return { ok: false, childCode: null, parentCode: null, error: 'ไม่พบงาน' }
  if (!child.bundleParentId) return { ok: true, childCode: child.bookingCode, parentCode: null } // already standalone

  // Best-effort: move the box back to its canonical outlet/program folder. A
  // move failure must NOT block clearing the link — the folder can be moved by
  // hand, and the id-first resolution keeps working wherever it sits.
  let moved = false
  const childBoxId = getDriveLink(child.driveFolders, 'box')
  if (root && childBoxId && hasDriveCredentials()) {
    try {
      if (await isFolderAlive(childBoxId)) {
        const normalParent = await canonicalProgramFolderId(child, root)
        const cur = await getDriveParentFolderId(childBoxId)
        if (cur && cur !== normalParent) { await moveFileToFolder(childBoxId, normalParent, cur); moved = true }
      }
    } catch (e: any) {
      console.warn('[bundle] unlink move-back failed (non-fatal):', child.bookingCode, e?.message || e)
    }
  }
  await prisma.booking.update({ where: { id: child.id }, data: { bundleParentId: null } })
  logAudit({
    actorEmail, action: 'booking.bundle_unlink', entityType: 'Booking', entityId: child.id,
    bookingCode: child.bookingCode, changes: { movedBack: moved, childBoxId },
  })
  return { ok: true, childCode: child.bookingCode, parentCode: null, moved }
}
