import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { resolveFootageFolders } from '@/lib/footage-folders'
import { findChildFolder, findChildFolderByCode, SOUND_STAGING_DIR } from '@/lib/google-drive'
import { bookingNeedsSound } from '@/lib/outlet-folders'

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
        bookingCode: true, projectId: true, projectName: true, category: true, crewRequired: true,
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

    const { folders, fileCount, bookingFolderUrl } = await resolveFootageFolders(booking)

    // v1.108 — Sound-crew bookings: surface the staging folder link so the sound
    // team drops audio there (DIRECT, outside the overwritten video folder); the
    // hourly sound-merge worker folds it into the box AUDIO.
    let soundStagingUrl: string | null = null
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (root && booking.bookingCode && bookingNeedsSound(booking.crewRequired)) {
      const stagingRoot = await findChildFolder(root, SOUND_STAGING_DIR)
      if (stagingRoot) {
        // v1.110 — match by Production ID (folder may be legacy "<code> · …" or the
        // new "<show> · … (<code>)" shape).
        const id = await findChildFolderByCode(stagingRoot, booking.bookingCode)
        if (id) soundStagingUrl = `https://drive.google.com/drive/folders/${id}`
      }
    }
    return NextResponse.json({ found: folders.length, fileCount, folders, bookingFolderUrl, soundStagingUrl })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/detect-footage error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
