import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { deleteDriveFile } from '@/lib/google-drive'
import { isCardRow } from '@/lib/ingest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload/[id]/cancel
 *
 * User-initiated abort. Cleans up:
 *   - Drive: deletes the reserved file slot (otherwise empty/partial file
 *            sits in the Shared Drive forever)
 *   - DB: flips Upload.status to FAILED + records the reason
 *   - FootageLog: deletes the pre-created row so the scanner doesn't
 *                 think this file is "in-flight" forever
 *
 * Idempotent: cancelling an already-FAILED or COMPLETE row is a no-op
 * with 200 (so the UI's "I lost the tab, cancel everything" button is
 * safe to over-call).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const upload = await prisma.upload.findUnique({ where: { id: params.id } })
    if (!upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
    if (upload.uploadedBy !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // v1.277 — a field-ingest card's driveFileId is the whole card FOLDER: the delete below is permanent (no
    // trash) and FAILED releases the footage-ready hold. Cards are released only via /api/upload/ingest `release`.
    if (isCardRow(upload.fileName)) {
      return NextResponse.json({ error: 'การ์ดส่งจากหน้างาน — ยกเลิกทางนี้ไม่ได้ (แอดมินใช้ปุ่ม "ปลด" บนหน้าอัป)', code: 'CARD_ROW' }, { status: 409 })
    }
    if (upload.status === 'COMPLETE') {
      return NextResponse.json({ ok: true, idempotent: true, reason: 'already complete' })
    }
    if (upload.status === 'FAILED') {
      return NextResponse.json({ ok: true, idempotent: true })
    }

    const errors: string[] = []

    // Drive delete (best-effort)
    if (upload.driveFileId) {
      try {
        await deleteDriveFile(upload.driveFileId)
      } catch (e: any) {
        errors.push(`Drive delete: ${e?.message || e}`)
      }
      try {
        await prisma.footageLog.delete({ where: { driveFileId: upload.driveFileId } })
      } catch {
        // Ignore — FootageLog might not have been created yet
      }
    }

    await prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: 'FAILED',
        failureReason: errors.length > 0
          ? `Cancelled by ${session.email}; cleanup errors: ${errors.join(' · ')}`
          : `Cancelled by ${session.email}`,
      },
    })

    return NextResponse.json({ ok: true, cleanupErrors: errors.length > 0 ? errors : undefined })
  } catch (e: any) {
    console.error('POST /api/upload/[id]/cancel error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
