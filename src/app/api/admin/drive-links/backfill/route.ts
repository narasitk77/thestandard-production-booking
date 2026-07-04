import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { mergeDriveLinks } from '@/lib/drive-links'
import {
  findEpisodeFolderUrls, listChildFolders, findChildFolder, hasDriveCredentials, SOUND_STAGING_DIR,
} from '@/lib/google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildBookingFolderName, legacyBookingFolderName,
  buildEpisodeFolderName, folderNameMatchesCode,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

/**
 * POST /api/admin/drive-links/backfill   { apply?: boolean, codes?: string[], days?: number }
 *
 * v1.114 — one-off: resolve each booking's Drive folders via TODAY's name
 * logic ONE more time and store the folder IDs on Booking.driveFolders, so
 * every later read takes the id-first fast path and renames can't break it.
 * Default DRY RUN (reports what would be stored). Idempotent — bookings that
 * already hold a link keep it (mergeDriveLinks only fills/updates with found
 * ids). Admin-only.
 */
export async function POST(request: NextRequest) {
  try {
    // Auth: admin session OR the internal shared secret (same one the NAS
    // agent uses) — this is an id-linkage tool, it cannot read footage.
    const headerSecret = request.headers.get('x-internal-secret')?.trim()
    const wantSecret = process.env.NAS_MANIFEST_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim()
    if (!headerSecret || !wantSecret || headerSecret !== wantSecret) {
      const session = await requireAdmin()
      if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (!root || !hasDriveCredentials()) return NextResponse.json({ error: 'Drive not configured' }, { status: 400 })

    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const days = Math.min(365, Math.max(1, parseInt(body?.days, 10) || 60))
    const codes: string[] | undefined = Array.isArray(body?.codes) && body.codes.length
      ? body.codes.filter((c: any) => typeof c === 'string')
      : undefined

    // Explicit per-booking overrides: [{ code, links: { box?, landing?, staging?, photo? } }].
    // For the folders no name logic can attribute (e.g. an ops folder named by
    // EP only) — the whole point of id-first linkage.
    const sets: Array<{ code: string; links: Record<string, string> }> = Array.isArray(body?.set)
      ? body.set.filter((x: any) => x && typeof x.code === 'string' && x.links && typeof x.links === 'object')
      : []
    if (sets.length) {
      const out: Array<{ code: string; links?: Record<string, string> | null; note?: string }> = []
      for (const it of sets) {
        const b = await prisma.booking.findFirst({ where: { bookingCode: it.code, deletedAt: null }, select: { id: true, driveFolders: true } })
        if (!b) { out.push({ code: it.code, note: 'booking not found' }); continue }
        const next = mergeDriveLinks(b.driveFolders, it.links as any)
        if (!next) { out.push({ code: it.code, note: 'no change (junk ids are dropped)' }); continue }
        if (apply) await prisma.booking.update({ where: { id: b.id }, data: { driveFolders: next } })
        out.push({ code: it.code, links: next })
      }
      return NextResponse.json({ ok: true, dryRun: !apply, mode: 'set', results: out })
    }

    const since = new Date(Date.now() - days * 24 * 3600_000)
    const bookings = await prisma.booking.findMany({
      where: {
        deletedAt: null,
        bookingCode: codes ? { in: codes } : { not: null },
        ...(codes ? {} : { shootDate: { gte: since } }),
      },
      select: {
        id: true, bookingCode: true, driveFolders: true, projectId: true, projectName: true, category: true,
        outlet: { select: { code: true } },
        program: { select: { name: true } },
        episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } } },
      },
    })

    // Landing + staging roots listed ONCE for the whole run.
    const landingKids = await listChildFolders(PRODUCTION_TEAM_ROOT)
    const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR).catch(() => null)
    const stagingKids = stagingRoot ? await listChildFolders(stagingRoot) : []

    const results: Array<{ code: string | null; links?: Record<string, string>; note?: string }> = []
    let stored = 0
    for (const b of bookings) {
      const code = b.bookingCode!
      try {
        const isAgency = b.outlet.code === 'AGN'
        const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
        const showName = bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
        const layers = shootFolderLayers({
          outletCode: b.outlet.code, showName, category: b.category,
          projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
        })
        const bookingCodeName = legacyBookingFolderName(code, jobName)
        const resolved = await findEpisodeFolderUrls({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(b.outlet.code),
          programFolderName: layers.programFolderName,
          bookingFolderName: isAgency ? bookingCodeName : layers.bookingFolderName,
          bookingFolderNameAlts: isAgency
            ? [layers.bookingFolderName, buildBookingFolderName(code, jobName, showName)]
            : [bookingCodeName],
          bookingCode: code,
          bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: code,
          episodeFolderNames: b.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency })),
        })
        // AGN without its per-booking layer yet: the resolved id is the SHARED
        // project box — storing that as "box" would make merges dump siblings'
        // trees together. Only store when the layer (or a non-AGN box) matched.
        const boxId = (!isAgency || resolved.viaBookingSubfolder) ? resolved.bookingFolderId : null
        const patch = {
          box: boxId ?? undefined,
          landing: landingKids.find(k => folderNameMatchesCode(k.name, code))?.id,
          staging: stagingKids.find(k => folderNameMatchesCode(k.name, code))?.id,
        }
        const next = mergeDriveLinks(b.driveFolders, patch)
        if (!next) { results.push({ code, note: 'no change' }); continue }
        if (apply) await prisma.booking.update({ where: { id: b.id }, data: { driveFolders: next } })
        stored++
        results.push({ code, links: next })
      } catch (e: any) {
        results.push({ code, note: `error: ${e?.message || e}` })
      }
    }

    return NextResponse.json({ ok: true, dryRun: !apply, bookings: bookings.length, stored, results })
  } catch (e: any) {
    console.error('POST /api/admin/drive-links/backfill error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
