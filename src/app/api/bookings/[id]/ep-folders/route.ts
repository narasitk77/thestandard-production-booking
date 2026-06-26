import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { findEpisodeFolderUrls } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bookings/[id]/ep-folders — per-EP "open footage on Drive" links.
 *
 * Resolves each episode's Drive folder by its DETERMINISTIC path (read-only, never
 * creates a folder) so footage MOVED from the NAS into the boxes surfaces per EP
 * exactly like uploaded footage. `url` is null for an EP whose folder doesn't
 * exist yet. Same read-scope as the booking detail (canViewBooking).
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
          select: { id: true, episodeId: true, sequence: true, title: true, program: { select: { name: true } } },
        },
      },
    })
    if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (!root || !booking.bookingCode) {
      return NextResponse.json({ bookingFolderUrl: null, episodes: [] })
    }

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

    const byName = new Map(resolved.episodes.map(e => [e.episodeFolderName, e.url]))
    // key by Episode.id (CUID, always unique) — episodeId is NOT unique per booking.
    const episodes = booking.episodes.map((e, i) => ({ id: e.id, url: byName.get(epNames[i]) ?? null }))
    return NextResponse.json({ bookingFolderUrl: resolved.bookingFolderUrl, episodes })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/ep-folders error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
