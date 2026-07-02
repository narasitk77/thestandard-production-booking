import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { renameDriveItem, getFileName } from '@/lib/google-drive'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/admin/rename-drive-folder  { folderId, newName }
 *
 * v1.111 — admin one-off: rename a Drive folder by id via the SERVICE ACCOUNT (the
 * account that owns/manages the footage tree), for box-name fixes the automated
 * flows don't cover — e.g. an AGN project box that ops want tagged with the specific
 * booking ID. Read the current name first, then rename; audited (drive.folder_renamed).
 * Admin-only. NOTE: footage auto-detect matches boxes by exact name, so pick a name
 * the resolver still accepts (for AGN that's "<bookingCode> · <project>" or
 * "<project> (<bookingCode>)").
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const folderId = String(body?.folderId || '').trim()
    const newName = String(body?.newName || '').trim()
    if (!folderId || !newName) {
      return NextResponse.json({ error: 'folderId and newName are required' }, { status: 400 })
    }

    const oldName = await getFileName(folderId).catch(() => null)
    if (oldName === null) {
      return NextResponse.json({ error: 'Folder not found or not accessible by the service account' }, { status: 404 })
    }
    if (oldName === newName) {
      return NextResponse.json({ ok: true, idempotent: true, folderId, name: newName })
    }

    await renameDriveItem(folderId, newName)

    logAudit({
      actorEmail: session.email,
      action: 'drive.folder_renamed',
      entityType: 'DriveFolder',
      entityId: folderId,
      changes: { oldName, newName },
    })

    return NextResponse.json({ ok: true, folderId, oldName, newName })
  } catch (e: any) {
    console.error('POST /api/admin/rename-drive-folder error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
