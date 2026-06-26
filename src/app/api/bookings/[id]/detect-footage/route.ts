import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { findEpisodeFolderUrls, listFilesRecursive, type DriveFile } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // recursive Drive walks can be slow for big bookings

/**
 * GET /api/bookings/[id]/detect-footage — DETECT footage actually sitting in the
 * booking's Drive folders, including files MOVED from the NAS into VIDEO 2026
 * (which have no Upload row, so the upload history can't see them). Resolves the
 * folder by its deterministic path (read-only), then recursively lists the files.
 *
 * Scope: non-AGN bookings live under a unique <Production ID> folder → scan the
 * whole thing. AGN bookings share one <Project> box across the project's bookings
 * → scan only THIS booking's EP folders so other bookings' footage isn't mixed in.
 * Same read-scope as the booking detail (canViewBooking).
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        bookingCode: true, projectId: true, projectName: true, category: true,
        createdByEmail: true, producerEmail: true, assignedEmails: true,
        outlet: { select: { code: true } },
        program: { select: { name: true } },
        episodes: {
          orderBy: { sequence: 'asc' },
          select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } },
        },
      },
    })
    if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (!root || !booking.bookingCode) return NextResponse.json({ found: 0, files: [], bookingFolderUrl: null })

    const isAgency = booking.outlet.code === 'AGN'
    const jobName = booking.projectName?.trim() || booking.episodes[0]?.title?.trim() || null
    const { programFolderName, bookingFolderName } = shootFolderLayers({
      outletCode: booking.outlet.code,
      showName: bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes }),
      category: booking.category,
      projectId: booking.projectId,
      projectName: booking.projectName,
      bookingCode: booking.bookingCode,
      jobName,
    })
    const epNames = booking.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency }))

    const resolved = await findEpisodeFolderUrls({
      rootFolderId: root,
      outletCanonicalName: outletDriveFolderName(booking.outlet.code),
      programFolderName,
      bookingFolderName,
      // AGN: also accept a box named after the Production ID (what ops sometimes use).
      bookingFolderNameAlts: isAgency ? [buildBookingFolderName(booking.bookingCode, jobName)] : undefined,
      episodeFolderNames: epNames,
    })

    // `_SHOOT.txt` / `_SHOOT-<id>.txt` are booking-info files, not footage.
    const isFootage = (f: DriveFile) => !/^_SHOOT\b.*\.txt$/i.test(f.name)

    // Aggregate footage into the FOLDERS that contain it (label + Drive link +
    // file count + size). Ops just want a clickable folder list, not 1000+ files —
    // so this also keeps the payload tiny and sidesteps the per-file display cap.
    const folderMap = new Map<string, { label: string; url: string; fileCount: number; totalBytes: number }>()
    const label = (...parts: string[]) => parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ')
    const add = (f: DriveFile, lbl: string) => {
      const parentId = f.parents[0]
      if (!parentId) return
      const cur = folderMap.get(parentId) ?? { label: lbl || '(box)', url: `https://drive.google.com/drive/folders/${parentId}`, fileCount: 0, totalBytes: 0 }
      cur.fileCount++
      cur.totalBytes += f.size ?? 0
      folderMap.set(parentId, cur)
    }

    if (isAgency) {
      // shared Project box. Scan THIS booking's EP folders (folderPath[0] = camera,
      // root = the EP folder)…
      const epFolders = resolved.episodes.filter(e => e.folderId)
      await Promise.all(epFolders.map(async e => {
        const raw = await listFilesRecursive(e.folderId!, { maxFiles: 5000 })
        raw.filter(isFootage).forEach(f => add(f, label(e.episodeFolderName, f.folderPath[0] ?? '')))
      }))
      // …PLUS "loose" footage filed directly in the box but NOT under an EP folder
      // (e.g. an event's OB / PGM / Rec.Stream recordings, which aren't per-episode).
      // Skip any project-EP folder ("<projectId>-…") so other bookings' EP footage
      // isn't mixed in; label by real folder depth (last = camera/group).
      if (resolved.bookingFolderId) {
        const epPrefix = `${(booking.projectId || '').toLowerCase()}-`
        const loose = await listFilesRecursive(resolved.bookingFolderId, {
          maxFiles: 5000,
          skipFolder: name => !!epPrefix && name.toLowerCase().startsWith(epPrefix),
        })
        loose.filter(isFootage).forEach(f => {
          const p = f.folderPath
          add(f, label(p.length >= 2 ? (p[p.length - 2] ?? '') : '', p[p.length - 1] ?? ''))
        })
      }
    } else if (resolved.bookingFolderId) {
      // unique Production-ID folder → scan it whole. Read the REAL depth: the file's
      // immediate parent (last path element) is the camera folder, the one above it
      // (if any) is the EP. Handles both <ID>/<EP>/<cam>/file and the legacy flat
      // <ID>/<cam>/file without guessing from booking.episodes.
      const raw = await listFilesRecursive(resolved.bookingFolderId, { maxFiles: 5000 })
      raw.filter(isFootage).forEach(f => {
        const p = f.folderPath
        add(f, label(p.length >= 2 ? (p[p.length - 2] ?? '') : '', p[p.length - 1] ?? ''))
      })
    }

    const folders = Array.from(folderMap.values()).sort((a, b) => a.label.localeCompare(b.label))
    const fileCount = folders.reduce((n, f) => n + f.fileCount, 0)
    return NextResponse.json({ found: folders.length, fileCount, folders, bookingFolderUrl: resolved.bookingFolderUrl })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/detect-footage error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
