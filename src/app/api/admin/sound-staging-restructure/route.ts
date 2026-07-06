import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  findChildFolder, listChildFolders, ensureFolderPath, moveFileToFolder,
  hasDriveCredentials, SOUND_STAGING_DIR, PRODUCTION_ID_IN_NAME_RE,
} from '@/lib/google-drive'
import { soundStagingCategoryName, sanitizeNameSegment } from '@/lib/outlet-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * v1.123 — one-off admin tool: reorganize the flat _SOUND-STAGING tree into
 * show categories (`_SOUND-STAGING/<รายการ>/<booking>/`).
 *
 * POST /api/admin/sound-staging-restructure   { execute?: true }
 * dryRun by default: returns the move plan without touching Drive. Moves keep
 * folder ids, so stored driveFolders.staging links stay valid (id-first).
 * Category per folder: resolved from the booking (by the Production ID in the
 * folder name) via soundStagingCategoryName; folders with no matching booking
 * use their name's show prefix (text before ' · ') or 'อื่นๆ'.
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

  const top = await listChildFolders(stagingRoot)
  const flatBookingFolders = top.filter(f => PRODUCTION_ID_IN_NAME_RE.test(f.name))
  const existingCategories = top.filter(f => !PRODUCTION_ID_IN_NAME_RE.test(f.name)).map(f => f.name)

  // Resolve every folder's target category (one DB query for all codes). The
  // folder's own code is the LAST match in the name — job titles occasionally
  // reference another booking's code, but the identity code sits in the
  // trailing "(<code>)" segment.
  const codes = flatBookingFolders.map(f => {
    const all = Array.from(f.name.matchAll(new RegExp(PRODUCTION_ID_IN_NAME_RE.source, 'g')))
    return all.length ? all[all.length - 1][0] : null
  })
  const bookings = await prisma.booking.findMany({
    where: { bookingCode: { in: codes.filter((c): c is string => !!c) } },
    select: {
      bookingCode: true, projectName: true,
      outlet: { select: { code: true } },
      program: { select: { code: true, name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { program: { select: { code: true, name: true } } } },
    },
  })
  const byCode = new Map(bookings.map(b => [b.bookingCode as string, b]))

  const plan: Array<{ folder: string; code: string | null; category: string; via: 'booking' | 'name' | 'fallback' }> = []
  for (let i = 0; i < flatBookingFolders.length; i++) {
    const f = flatBookingFolders[i]
    const code = codes[i]
    const b = code ? byCode.get(code) : undefined
    let category: string
    let via: 'booking' | 'name' | 'fallback'
    if (b) {
      category = soundStagingCategoryName({ outletCode: b.outlet.code, projectName: b.projectName, program: b.program, episodes: b.episodes })
      via = 'booking'
    } else {
      // Name shape: "<show> · <job> (<code>)" where <show> itself may contain
      // " · " (universal show types) — so strip the trailing "(code)" and cut
      // at the LAST separator, keeping the full show segment.
      const base = f.name.replace(/\s*\([^()]*\)\s*$/, '').trim()
      const cut = base.lastIndexOf(' · ')
      const prefix = sanitizeNameSegment(cut > 0 ? base.slice(0, cut) : '')
      if (prefix && !PRODUCTION_ID_IN_NAME_RE.test(prefix)) {
        category = prefix; via = 'name'
      } else {
        category = 'อื่นๆ'; via = 'fallback'
      }
    }
    plan.push({ folder: f.name, code, category, via })
  }

  const summary: Record<string, number> = {}
  for (const p of plan) summary[p.category] = (summary[p.category] || 0) + 1

  if (!execute) {
    return NextResponse.json({ dryRun: true, flat: flatBookingFolders.length, existingCategories, plan, summary })
  }

  // Execute: ensure each category folder once, then move.
  const catIds = new Map<string, string>()
  let moved = 0
  const errors: Array<{ folder: string; error: string }> = []
  for (let i = 0; i < flatBookingFolders.length; i++) {
    const f = flatBookingFolders[i]
    const p = plan[i]
    try {
      let catId = catIds.get(p.category)
      if (!catId) {
        catId = await ensureFolderPath(stagingRoot, [p.category])
        catIds.set(p.category, catId)
      }
      await moveFileToFolder(f.id, catId, stagingRoot)
      moved++
    } catch (e: any) {
      errors.push({ folder: f.name, error: e?.message || String(e) })
    }
  }
  logAudit({
    actorEmail: session.email,
    action: 'sound-staging.restructure',
    entityType: 'Drive',
    entityId: stagingRoot,
    changes: { moved, errors: errors.length, categories: Object.keys(summary).length },
  })
  return NextResponse.json({ dryRun: false, moved, errors, summary })
}
