import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  findChildFolder, ensureFolderPath, moveFileToFolder, isFolderEmpty, deleteDriveFile,
  hasDriveCredentials, SOUND_STAGING_DIR, PRODUCTION_ID_IN_NAME_RE, listSoundStagingTree,
  type StagingContainer,
} from '@/lib/google-drive'
import { soundStagingCategoryName, outletDriveFolderName, sanitizeNameSegment } from '@/lib/outlet-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// v1.125 review fix — a same-process guard against a double-click/retry firing
// two overlapping executes (each would build its own plan from the same live
// snapshot and race their moves/deletes). Single container deployment, so a
// module-level flag is sufficient; dryRun is read-only and never gated.
let restructureRunning = false

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Resolve a container's id by a NORMALIZED (trim+lowercase) name match against
 * what's already live on Drive — never Drive's exact-string `ensureChildFolder`.
 * v1.125 review fix — exact-match would silently fork a duplicate the moment a
 * freshly computed name drifts from what's live (casing, stray whitespace),
 * and the ORIGINAL folder — now emptied by the move — gets hard-deleted by the
 * cleanup pass. Matching by normalized name (and caching by resolved id from
 * then on) makes `alreadyPlaced`/move decisions immune to that drift entirely.
 * `allowCreate=false` (dryRun) never touches Drive — a would-be-new container
 * resolves to null.
 */
async function resolveContainerId(
  parentId: string,
  name: string,
  existingByParent: Map<string, StagingContainer[]>,
  cache: Map<string, string>,
  allowCreate: boolean,
): Promise<string | null> {
  const key = `${parentId}||${norm(name)}`
  const cached = cache.get(key)
  if (cached) return cached
  const existing = (existingByParent.get(parentId) || []).find(c => norm(c.name) === norm(name))
  if (existing) { cache.set(key, existing.id); return existing.id }
  if (!allowCreate) return null
  const id = await ensureFolderPath(parentId, [name])
  cache.set(key, id)
  return id
}

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
 * At execute time, containers left empty by a move (the old v1.123 category
 * folders, and their outlet parent too if that also empties out) are deleted —
 * each verified empty via a live Drive read immediately before deletion, and
 * never a container still in active use as a target.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const execute = body?.execute === true

  if (execute) {
    if (restructureRunning) return NextResponse.json({ error: 'มีการ restructure กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    restructureRunning = true
  }

  try {
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (!root || !hasDriveCredentials()) return NextResponse.json({ error: 'Drive ยังไม่ได้ตั้งค่า' }, { status: 400 })
    const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
    if (!stagingRoot) return NextResponse.json({ error: 'ไม่พบ _SOUND-STAGING' }, { status: 404 })

    // maxDepth 4 (one level of margin beyond the intended outlet+category+booking
    // shape) so a stray non-conforming folder at the category level doesn't
    // silently vanish from both the plan and the cleanup sweep.
    const tree = await listSoundStagingTree(stagingRoot, 4)

    const outletContainersByParent = new Map<string, StagingContainer[]>([[stagingRoot, tree.containers.filter(c => c.depth === 1)]])
    const categoryContainersByOutletId = new Map<string, StagingContainer[]>()
    const containerParentOf = new Map<string, string>()
    for (const c of tree.containers) {
      containerParentOf.set(c.id, c.parentId)
      if (c.depth === 2) {
        const arr = categoryContainersByOutletId.get(c.parentId) || []
        arr.push(c); categoryContainersByOutletId.set(c.parentId, arr)
      }
    }
    const outletIdCache = new Map<string, string>()
    const categoryIdCache = new Map<string, string>()
    const resolveTarget = async (outletName: string, categoryName: string, allowCreate: boolean) => {
      const outletId = await resolveContainerId(stagingRoot as string, outletName, outletContainersByParent, outletIdCache, allowCreate)
      if (!outletId) return { outletId: null as string | null, categoryId: null as string | null }
      const categoryId = await resolveContainerId(outletId, categoryName, categoryContainersByOutletId, categoryIdCache, allowCreate)
      return { outletId, categoryId }
    }

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
      // dryRun: read-only resolution (allowCreate=false) — an as-yet-nonexistent
      // target resolves to null, so alreadyPlaced correctly comes out false.
      const { categoryId } = await resolveTarget(outlet, category, false)
      const alreadyPlaced = categoryId !== null && f.parentId === categoryId
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

    // Execute: resolve (creating where needed) each target, move what isn't
    // already there. resolveTarget's own cache means each unique outlet/category
    // pair is only ensured/created once even though many bookings share one.
    const oldParents = new Set<string>() // captured BEFORE moving — candidates to clean up after
    let moved = 0
    const errors: Array<{ folder: string; error: string }> = []
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]
      if (p.alreadyPlaced) continue
      const bookingFolder = tree.bookings[i]
      try {
        const { categoryId } = await resolveTarget(p.outlet, p.category, true)
        if (!categoryId) throw new Error('resolveTarget returned no id with allowCreate=true')
        if (p.parentId !== stagingRoot) oldParents.add(p.parentId)
        await moveFileToFolder(bookingFolder.id, categoryId, p.parentId)
        moved++
      } catch (e: any) {
        errors.push({ folder: p.folder, error: e?.message || String(e) })
      }
    }

    // Cleanup: a container that only ever held folders which just moved away is
    // now empty — verified live (never trusted from the plan) right before
    // deleting, since this is a real, non-trash Drive delete. Never touch a
    // container that is itself a valid, currently-used target. Walks upward
    // (category → its outlet) so an outlet left fully empty is cleaned up too.
    const usedTargetIds = new Set([...Array.from(outletIdCache.values()), ...Array.from(categoryIdCache.values())])
    let deletedContainers = 0
    const deleteErrors: Array<{ id: string; error: string }> = []
    const tryDeleteEmptyChain = async (id: string): Promise<void> => {
      if (id === stagingRoot || usedTargetIds.has(id)) return
      try {
        if (!(await isFolderEmpty(id))) return
        await deleteDriveFile(id)
        deletedContainers++
        const parent = containerParentOf.get(id)
        if (parent) await tryDeleteEmptyChain(parent)
      } catch (e: any) {
        deleteErrors.push({ id, error: e?.message || String(e) })
      }
    }
    for (const id of Array.from(oldParents)) await tryDeleteEmptyChain(id)

    logAudit({
      actorEmail: session.email,
      action: 'sound-staging.restructure-outlet-layer',
      entityType: 'Drive',
      entityId: stagingRoot,
      changes: { moved, errors: errors.length, deletedContainers, deleteErrors: deleteErrors.length, categories: Object.keys(summary).length },
    })
    return NextResponse.json({ dryRun: false, moved, errors, deletedContainers, deleteErrors, summary })
  } finally {
    if (execute) restructureRunning = false
  }
}
