import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { getDriveParentFolderId } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/folders?bookingId=...
 *
 * v1.82 — per-camera Drive folder links for a booking. For each camera that
 * has completed uploads, return a link to the Drive folder the footage lives
 * in (derived from a completed file's parent, so it works for files uploaded
 * before we tracked the folder id). Lets the upload/task view show
 * "CAM-A → open Drive folder" once footage is in.
 *
 * Auth: same gate as /api/upload/list (console reads freely; crew need upload
 * access to the booking).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const bookingId = new URL(request.url).searchParams.get('bookingId')?.trim()
    if (!bookingId) return NextResponse.json({ error: 'bookingId is required' }, { status: 400 })

    if (!hasConsoleAccess(session.role)) {
      const check = await canUploadToBooking(session.email, bookingId)
      if (!check.ok) return NextResponse.json({ error: 'Forbidden', code: check.reason }, { status: 403 })
    }

    const rows = await prisma.upload.findMany({
      where: { bookingId, status: 'COMPLETE', driveFileId: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: { camera: true, driveFileId: true },
    })

    // One representative file per camera (+ count). Newest first so the
    // representative is a fresh, still-existing file.
    const byCamera = new Map<string, { fileId: string; count: number }>()
    for (const r of rows) {
      const e = byCamera.get(r.camera)
      if (e) e.count++
      else byCamera.set(r.camera, { fileId: r.driveFileId!, count: 1 })
    }

    const folders = await Promise.all(
      Array.from(byCamera.entries()).map(async ([camera, { fileId, count }]) => {
        let folderId: string | null = null
        try { folderId = await getDriveParentFolderId(fileId) } catch { /* file gone / API hiccup → no link */ }
        return {
          camera,
          count,
          folderId,
          folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : null,
        }
      }),
    )
    folders.sort((a, b) => a.camera.localeCompare(b.camera))

    return NextResponse.json({ folders })
  } catch (e: any) {
    console.error('GET /api/upload/folders error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
