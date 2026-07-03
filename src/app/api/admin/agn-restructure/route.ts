import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { runAgnRestructure } from '@/lib/agn-restructure'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/admin/agn-restructure   { apply?: boolean, projectId?: string }
 *
 * v1.112 one-off: reorganize AGN project boxes into the per-booking layout
 * (project box → "<job> (<code>)" → EP folders). Default is a DRY RUN returning
 * the full move plan + ambiguous/unmapped items; pass { apply: true } to execute.
 * Optional projectId scopes the sweep to one project. Admin-only.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    const body = await request.json().catch(() => ({}))
    const apply = body?.apply === true
    const projectId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined
    const result = await runAgnRestructure({ dryRun: !apply, projectId })
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('POST /api/admin/agn-restructure error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
