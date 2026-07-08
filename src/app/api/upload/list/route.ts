import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/list?bookingId=...
 *
 * Returns every Upload row attached to the booking, newest first. Used
 * by the Upload tab on /admin/[id] to render the "already uploaded for
 * this booking" list — both completed files (with Drive link) and
 * in-flight ones (so a returning crew member sees their current
 * progress).
 *
 * Auth: same gate as upload itself (video/sound crew or admin).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const bookingId = searchParams.get('bookingId')?.trim()
    if (!bookingId) {
      return NextResponse.json({ error: 'bookingId query parameter is required' }, { status: 400 })
    }

    // v1.35.3 — same per-booking gate as /api/upload/init. Listing the
    // history of a booking you can't upload to leaks who's been on that
    // shoot, so we tie list visibility to upload permission.
    // v1.50 — console tiers read freely: the upload-review panel on
    // /admin/[id] needs this list, and its Mark-Done POST is already
    // requireConsole. Write routes keep the crew-only gate.
    if (!hasConsoleAccess(session.role)) {
      const check = await canUploadToBooking(session.email, bookingId)
      if (!check.ok) {
        return NextResponse.json({ error: 'Forbidden', code: check.reason }, { status: 403 })
      }
    }

    const rows = await prisma.upload.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        camera: true,
        status: true,
        driveFileId: true,
        driveUrl: true,
        uploadedBy: true,
        initiatedAt: true,
        completedAt: true,
        failureReason: true,
      },
    })

    // BigInt → number for JSON
    const uploads = rows.map(r => ({
      ...r,
      fileSize: r.fileSize != null ? Number(r.fileSize) : null,
    }))

    return NextResponse.json({ uploads })
  } catch (e: any) {
    console.error('GET /api/upload/list error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
