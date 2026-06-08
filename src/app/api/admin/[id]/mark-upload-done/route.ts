import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { assessCompleteness } from '@/lib/upload-completeness'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/[id]/mark-upload-done
 *
 * After crew has uploaded both video and sound, an admin reviews the
 * upload log and confirms the booking is "Done" — this endpoint flips
 * BookingStatus from CONFIRMED → COMPLETED and writes an AuditLog row
 * so we can trace who signed off.
 *
 * Re-checks completeness server-side so a race (file deleted between
 * the list query + this confirm POST) can't slip past the gate.
 *
 * Body: { note?: string } — optional reviewer note recorded on the
 * audit row for context (e.g. "all 4 cameras + sound + B-roll OK").
 *
 * Idempotent on COMPLETED: a second POST returns 200 with
 * `idempotent: true` so the UI's "I lost track, mark again" press is
 * safe.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await requireConsole()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const note = body.note ? String(body.note).trim().slice(0, 1000) : null

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        uploads: { select: { camera: true, status: true, fileSize: true } },
      },
    })
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    if (booking.status === 'COMPLETED') {
      return NextResponse.json({
        ok: true,
        idempotent: true,
        booking: { id: booking.id, status: booking.status, bookingCode: booking.bookingCode },
      })
    }
    if (booking.status !== 'CONFIRMED') {
      return NextResponse.json({
        error: `Cannot mark a ${booking.status} booking as Done — only CONFIRMED bookings can be reviewed`,
        code: 'BAD_BOOKING_STATUS',
      }, { status: 400 })
    }

    const report = assessCompleteness(booking.uploads)
    if (!report.isReady) {
      return NextResponse.json({
        error: report.hasVideo
          ? 'Sound upload missing — review queue requires at least one COMPLETE sound upload'
          : report.hasSound
            ? 'Video upload missing — review queue requires at least one COMPLETE video upload'
            : 'Both video and sound uploads are missing',
        code: 'INCOMPLETE_UPLOAD',
        report: { ...report, totalBytes: Number(report.totalBytes) },
      }, { status: 400 })
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'COMPLETED' },
      select: {
        id: true, bookingCode: true, status: true,
        outlet: { select: { code: true, name: true } },
        program: { select: { code: true, name: true } },
      },
    })

    // Audit trail — who confirmed, what they saw, optional note. The
    // logAudit helper is fire-and-forget but we await here so a /admin
    // refresh right after the POST shows the row in the audit list.
    await logAudit({
      actorEmail: session.email,
      action: 'booking.mark_upload_done',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      fromStatus: 'CONFIRMED',
      toStatus: 'COMPLETED',
      changes: {
        videoCount: report.videoCount,
        soundCount: report.soundCount,
        inFlightCount: report.inFlightCount,
        failedCount: report.failedCount,
        totalBytes: Number(report.totalBytes),
        note,
      },
    })

    return NextResponse.json({
      ok: true,
      booking: updated,
      report: { ...report, totalBytes: Number(report.totalBytes) },
    })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/mark-upload-done error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
