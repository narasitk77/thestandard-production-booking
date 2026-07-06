import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  findChildFolder, ensureFolderPath, moveFileToFolder, isFolderEmpty, deleteDriveFile,
  hasDriveCredentials, SOUND_STAGING_DIR, PRODUCTION_ID_IN_NAME_RE, listSoundStagingTree,
} from '@/lib/google-drive'
import { soundStagingCategoryName, outletDriveFolderName, sanitizeNameSegment } from '@/lib/outlet-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * v1.125 — one-off admin tool: add the outlet layer on top of the v1.123 show
 * categories, mirroring VIDEO 2026 [JUL-DEC]'s numbered outlet root:
 *   _SOUND-STAGING/<NN · Outlet>/<รายการ>/<booking>/
 *
 * POST /api/admin/sound-staging-restructure   { execute?: true }
 * dryRun by default: returns the move plan without touching Drive. Finds every
 * booking folder at ANY existing depth (flat / category-only / outlet+category)
 * via listSoundStagingTree, so re-running after a partial prior run is safe —
 * only folders NOT already at the correct outlet+category path move. Moves
 * preserve folder ids (driveFolders.staging links stay valid, id-first).
 * At execute time, any container left empty by a move (e.g. the old flat
 * category folders from the v1.123 layout) is deleted — verified empty via a
 * live Drive read immediately before deletion.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const execute = body?.execute === true

  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return NextResponse.json({ error: 'Drive ยังไม่ได้ตั้งค่า' }, { status: 400 })
  const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
  if (!stagingRoot) return NextResponse.json({ error: 'ไม่พบ _SOUND-STAGING' }, { status: 404 })

  const tree = await listSoundStagingTree(stagingRoot, 3)

  // Resolve every folder's target outlet + category (one DB query for all
  // codes). The folder's own code is the LAST match in the name — job titles
  // occasionally reference another booking's code, but the identity code sits
  // in the trailing "(<code>)" segment.
  const codes = tree.bookings.map(f => {
    const all = Array.from(f.name.matchAll(new RegExp(PRODUCTION_ID_IN_NAME_RE.source, 'g')))
    return all.length ? all[all.length - 1][0] : null
  })
  const dbBookings = await prisma.booking.findMany({
    where: { bookingCode: { in: codes.filter((c): c is string => !!c) } },
    select: {
      bookingCode: true, projectName: true,
      outlet: { select: { code: true } },
      program: { select: { code: true, name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { program: { select: { code: true, name: true } } } },
    },
  })
  const byCode = new Map(dbBookings.map(b => [b.bookingCode as string, b]))

  const plan: Array<{
    folder: string; code: string | null; outlet: string; category: string
    via: 'booking' | 'name' | 'fallback'; alreadyPlaced: boolean; parentId: string
  }> = []
  for (let i = 0; i < tree.bookings.length; i++) {
    const f = tree.bookings[i]
    const code = codes[i]
    const b = code ? byCode.get(code) : undefined
    let outletCode: string
    let category: string
    let via: 'booking' | 'name' | 'fallback'
    if (b) {
      outletCode = b.outlet.code
      category = soundStagingCategoryName({ outletCode: b.outlet.code, projectName: b.projectName, program: b.program, episodes: b.episodes })
      via = 'booking'
    } else {
      // Every booking-folder entry matched PRODUCTION_ID_IN_NAME_RE, so a code
      // always exists here — the outlet is its prefix (OUTLET[-PROG]-YYMMDD[-TYPE]-NN).
      outletCode = (code || '').split('-')[0] || ''
      // Name shape: "<show> · <job> (<code>)" where <show> itself may contain
      // " · " (universal show types) — strip the trailing "(code)" and cut at
      // the LAST separator, keeping the full show segment.
      const base = f.name.replace(/\s*\([^()]*\)\s*$/, '').trim()
      const cut = base.lastIndexOf(' · ')
      const prefix = sanitizeNameSegment(cut > 0 ? base.slice(0, cut) : '')
      if (prefix && !PRODUCTION_ID_IN_NAME_RE.test(prefix)) {
        category = prefix; via = 'name'
      } else {
        category = 'อื่นๆ'; via = 'fallback'
      }
    }
    const outlet = outletDriveFolderName(outletCode || 'UNK')
    const alreadyPlaced = f.pathNames.length === 2 && f.pathNames[0] === outlet && f.pathNames[1] === category
    plan.push({ folder: f.name, code, outlet, category, via, alreadyPlaced, parentId: f.parentId })
  }

  const summary: Record<string, number> = {}
  for (const p of plan) { const k = `${p.outlet} / ${p.category}`; summary[k] = (summary[k] || 0) + 1 }
  const toMove = plan.filter(p => !p.alreadyPlaced).length

  if (!execute) {
    return NextResponse.json({
      dryRun: true, totalBookingFolders: tree.bookings.length, alreadyPlaced: tree.bookings.length - toMove,
      toMove, summary, plan,
    })
  }

  // Execute: ensure each outlet/category folder once, move what isn't already there.
  const targetIds = new Map<string, string>()
  const oldParents = new Set<string>() // captured BEFORE moving — candidates to clean up after
  let moved = 0
  const errors: Array<{ folder: string; error: string }> = []
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    if (p.alreadyPlaced) continue
    const bookingFolder = tree.bookings[i]
    try {
      const key = `${p.outlet}||${p.category}`
      let catId = targetIds.get(key)
      if (!catId) { catId = await ensureFolderPath(stagingRoot, [p.outlet, p.category]); targetIds.set(key, catId) }
      if (p.parentId !== stagingRoot) oldParents.add(p.parentId)
      await moveFileToFolder(bookingFolder.id, catId, p.parentId)
      moved++
    } catch (e: any) {
      errors.push({ folder: p.folder, error: e?.message || String(e) })
    }
  }

  // Cleanup: a container that only ever held folders which just moved away is
  // now empty — verified live (never trusted from the plan) right before
  // deleting, since this is a real Drive delete. Never touch a container that
  // is itself a valid, currently-used target.
  const usedTargetIds = new Set(targetIds.values())
  let deletedContainers = 0
  const deleteErrors: Array<{ id: string; error: string }> = []
  for (const id of Array.from(oldParents)) {
    if (usedTargetIds.has(id)) continue
    try {
      if (await isFolderEmpty(id)) { await deleteDriveFile(id); deletedContainers++ }
    } catch (e: any) {
      deleteErrors.push({ id, error: e?.message || String(e) })
    }
  }

  logAudit({
    actorEmail: session.email,
    action: 'sound-staging.restructure-outlet-layer',
    entityType: 'Drive',
    entityId: stagingRoot,
    changes: { moved, errors: errors.length, deletedContainers, deleteErrors: deleteErrors.length, categories: Object.keys(summary).length },
  })
  return NextResponse.json({ dryRun: false, moved, errors, deletedContainers, deleteErrors, summary })
}
