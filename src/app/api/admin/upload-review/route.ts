import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { assessCompleteness } from '@/lib/upload-completeness'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/upload-review
 *
 * Returns the booking review queue: CONFIRMED bookings that have at
 * least one COMPLETE video upload AND at least one COMPLETE sound
 * upload. These are ready for the admin to look over the log + mark
 * the booking as Done (status → COMPLETED).
 *
 * Bookings still missing video / sound stay off this endpoint — they're
 * "in progress", not "ready to close". A separate endpoint or
 * `?includeInProgress=1` could surface those for visibility later.
 *
 * Sort: shootDate desc — newest shoots float to the top so they get
 * reviewed while still fresh.
 */
export async function GET() {
  if (!(await requireConsole())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  // Pull all CONFIRMED bookings + their uploads. For a typical week's
  // backlog this is a few dozen rows; we don't bother paginating yet.
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', deletedAt: null },
    orderBy: { shootDate: 'desc' },
    select: {
      id: true,
      bookingCode: true,
      shootDate: true,
      callTime: true,
      estimatedWrap: true,
      producer: true,
      assignedEmails: true,
      mainVideographerEmail: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { code: true, name: true } },
      uploads: {
        select: { camera: true, status: true, fileSize: true, uploadedBy: true, updatedAt: true },
      },
    },
  })

  const ready: any[] = []
  const inProgress: any[] = []  // has at least one upload but missing video or sound

  for (const b of bookings) {
    const report = assessCompleteness(b.uploads)
    if (report.videoCount === 0 && report.soundCount === 0 && report.inFlightCount === 0) {
      // No uploads at all — not in the review pipeline yet
      continue
    }
    const uploaders = Array.from(new Set(b.uploads.map(u => u.uploadedBy).filter(Boolean)))
    const lastUploadAt = b.uploads.length === 0
      ? null
      : b.uploads.reduce<Date | null>((max, u) => (!max || u.updatedAt > max) ? u.updatedAt : max, null)

    const row = {
      id: b.id,
      bookingCode: b.bookingCode,
      shootDate: b.shootDate,
      callTime: b.callTime,
      estimatedWrap: b.estimatedWrap,
      producer: b.producer,
      assignedEmails: b.assignedEmails,
      mainVideographerEmail: b.mainVideographerEmail,
      outlet: b.outlet,
      program: b.program,
      uploaders,
      lastUploadAt,
      ...report,
      totalBytes: Number(report.totalBytes),
    }
    if (report.isReady) ready.push(row)
    else inProgress.push(row)
  }

  return NextResponse.json({
    ready,
    inProgress,
    counts: { ready: ready.length, inProgress: inProgress.length },
  })
}
