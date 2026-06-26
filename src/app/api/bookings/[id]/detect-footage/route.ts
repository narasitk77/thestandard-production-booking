import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { findEpisodeFolderUrls, listFilesRecursive, type DriveFile } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

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
      episodeFolderNames: epNames,
    })

    const mapFile = (f: DriveFile, ep: string, camera: string) => ({
      name: f.name,
      sizeBytes: f.size,
      ep,
      camera,
      url: f.webViewLink,
      modifiedTime: f.modifiedTime,
    })

    let files: ReturnType<typeof mapFile>[] = []
    if (isAgency && booking.episodes.length) {
      // shared Project box → scan only this booking's EP folders (folderPath[0] = camera)
      const epFolders = resolved.episodes.filter(e => e.folderId)
      const perEp = await Promise.all(epFolders.map(async e => {
        const raw = await listFilesRecursive(e.folderId!, { maxFiles: 1000 })
        return raw.map(f => mapFile(f, e.episodeFolderName, f.folderPath[0] ?? ''))
      }))
      files = perEp.flat()
    } else if (resolved.bookingFolderId) {
      // unique Production-ID folder → scan it whole (folderPath = [EP, camera])
      const raw = await listFilesRecursive(resolved.bookingFolderId, { maxFiles: 1500 })
      files = raw.map(f => mapFile(f, f.folderPath[0] ?? '', f.folderPath[1] ?? ''))
    }

    return NextResponse.json({ found: files.length, files, bookingFolderUrl: resolved.bookingFolderUrl })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/detect-footage error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
