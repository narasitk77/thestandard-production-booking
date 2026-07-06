import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { isFolderEmpty, deleteDriveFile, hasDriveCredentials } from '@/lib/google-drive'
import { google } from 'googleapis'
import { getDriveReadAuth } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

/**
 * v1.126 — targeted cleanup of stale Drive shells (the "โคตรมั่ว" leftovers:
 * empty EP folders from a postponed booking + its orphaned _SHOOT-*.txt).
 *
 * POST /api/admin/drive-cleanup  { ids: string[], execute?: true }
 * Guarded hard: a FOLDER is deleted only when a LIVE check shows zero children;
 * a FILE only when it's a small `_SHOOT-*.txt` booking-info stub. Anything else
 * is refused. dryRun by default reports what each id is and what would happen.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  if (!hasDriveCredentials()) return NextResponse.json({ error: 'Drive ยังไม่ได้ตั้งค่า' }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String) : []
  const execute = body?.execute === true
  if (ids.length === 0 || ids.length > 25) return NextResponse.json({ error: 'ids: 1–25 รายการ' }, { status: 400 })

  const drive = google.drive({ version: 'v3', auth: getDriveReadAuth() })
  const results: Array<{ id: string; name?: string; kind?: string; action: string }> = []
  for (const id of ids) {
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType, size, trashed', supportsAllDrives: true })
      const name = meta.data.name || ''
      const isFolder = meta.data.mimeType === 'application/vnd.google-apps.folder'
      if (meta.data.trashed) { results.push({ id, name, action: 'skip: already trashed' }); continue }
      if (isFolder) {
        const empty = await isFolderEmpty(id)
        if (!empty) { results.push({ id, name, kind: 'folder', action: 'REFUSED: not empty' }); continue }
        if (execute) await deleteDriveFile(id)
        results.push({ id, name, kind: 'folder(empty)', action: execute ? 'deleted' : 'would delete' })
      } else {
        const small = Number(meta.data.size || 0) < 10 * 1024
        const isShootStub = /^_SHOOT.*\.txt$/i.test(name)
        if (!small || !isShootStub) { results.push({ id, name, kind: 'file', action: 'REFUSED: only small _SHOOT-*.txt stubs' }); continue }
        if (execute) await deleteDriveFile(id)
        results.push({ id, name, kind: 'shoot-stub', action: execute ? 'deleted' : 'would delete' })
      }
    } catch (e: any) {
      results.push({ id, action: `error: ${e?.message || e}` })
    }
  }
  if (execute) {
    logAudit({
      actorEmail: session.email, action: 'drive.cleanup', entityType: 'Drive', entityId: 'drive-cleanup',
      changes: { deleted: results.filter(r => r.action === 'deleted').map(r => `${r.name} (${r.id})`) },
    })
  }
  return NextResponse.json({ dryRun: !execute, results })
}
