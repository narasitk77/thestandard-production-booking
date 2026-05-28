import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getUploadAccess } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/list?bookingId=...
 *
 * Returns every Upload row attached to the booking, newest first. Used
 * by the Upload tab on /admin/[id] to render the "already uploaded for
 * this booking" list — both completed files (with Drive link + Wasabi
 * key) and in-flight ones (so a returning crew member sees their
 * current progress).
 *
 * Auth: same gate as upload itself (video/sound crew or admin).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await getUploadAccess(session.email))) {
      return NextResponse.json({ error: 'Upload access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const bookingId = searchParams.get('bookingId')?.trim()
    if (!bookingId) {
      return NextResponse.json({ error: 'bookingId query parameter is required' }, { status: 400 })
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
        wasabiBucket: true,
        wasabiKey: true,
        wasabiEtag: true,
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
