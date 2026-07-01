import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { runFolderRename } from '@/lib/rename-folders'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/admin/rename-folders   { apply?: boolean }
 *
 * v1.110 one-off: rename existing Drive folders (VIDEO box / sound-staging / photo /
 * Production Team landing) from the legacy "<code> · <job>" shape to the show-first
 * "<show> · <job> (<code>)" shape. Default is a DRY RUN (reports every old→new
 * change, touches nothing). Pass { apply: true } to execute. Idempotent — a folder
 * already in the target shape is left alone. Admin-only.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const result = await runFolderRename({ dryRun: !apply })
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('POST /api/admin/rename-folders error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
