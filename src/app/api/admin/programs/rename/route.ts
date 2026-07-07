import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { getOutlet } from '@/lib/data'
import { outletDriveFolderName } from '@/lib/outlet-folders'
import { findProgramFolderId, renameDriveItem, hasDriveCredentials } from '@/lib/google-drive'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/admin/programs/rename  { outletCode, code, newName }
 *
 * v1.128 — rename a show (Program row). Programs are seeded from the static
 * src/lib/data.ts list with `update: {}` upserts, so fixing a name there does
 * NOT touch rows already in the DB — this endpoint closes that gap (born from
 * the 7TG case: DB said "7 Things I love about...", the real show is
 * "7 THINGS WE LOVE ABOUT..."). Also best-effort renames the outlet's Drive
 * program folder when it still carries the old name, so prep-folder lookups
 * (exact name match) keep landing in the same folder. Admin-only, audited.
 * Keep src/lib/data.ts in sync manually — it is the seed for fresh DBs.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const outletCode = String(body?.outletCode || '').trim().toUpperCase()
    const code = String(body?.code || '').trim().toUpperCase()
    const newName = String(body?.newName || '').trim()
    if (!outletCode || !code || !newName) {
      return NextResponse.json({ error: 'outletCode, code and newName are required' }, { status: 400 })
    }
    if (!getOutlet(outletCode)) return NextResponse.json({ error: `Unknown outlet: ${outletCode}` }, { status: 400 })

    const outletDb = await prisma.outlet.findUnique({ where: { code: outletCode } })
    if (!outletDb) return NextResponse.json({ error: 'Outlet has no DB row yet' }, { status: 404 })
    const program = await prisma.program.findUnique({ where: { code_outletId: { code, outletId: outletDb.id } } })
    if (!program) return NextResponse.json({ error: `Program ${code} not found in ${outletCode}` }, { status: 404 })

    const oldName = program.name
    if (oldName === newName) return NextResponse.json({ ok: true, idempotent: true, code, name: newName })

    await prisma.program.update({ where: { id: program.id }, data: { name: newName } })

    // Best-effort: if the Drive program folder still carries the old name,
    // rename it too (exact-name lookups in prep/detect depend on it). A folder
    // ops already renamed simply won't match — that's fine, skip silently.
    let driveRenamed = false
    const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
    if (root && hasDriveCredentials()) {
      try {
        const folderId = await findProgramFolderId(root, outletDriveFolderName(outletCode), oldName)
        if (folderId) { await renameDriveItem(folderId, newName); driveRenamed = true }
      } catch (e: any) {
        console.warn('[programs/rename] drive folder rename skipped:', e?.message || e)
      }
    }

    logAudit({
      actorEmail: session.email,
      action: 'program.renamed',
      entityType: 'Program',
      entityId: program.id,
      changes: { outletCode, code, oldName, newName, driveRenamed },
    })

    return NextResponse.json({ ok: true, code, outletCode, oldName, newName, driveRenamed })
  } catch (e: any) {
    console.error('POST /api/admin/programs/rename error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
