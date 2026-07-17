import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { linkBookingBundle, unlinkBookingBundle } from '@/lib/booking-bundle'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // a whole-folder Drive move + box ensure

/**
 * POST   /api/admin/[id]/bundle   { parentId }   — link this booking's footage
 *        box into parentId's box (parentId = the "home"/main-program booking).
 * DELETE /api/admin/[id]/bundle                  — unlink (move box back out).
 * Admin only. [id] is the CHILD (the shoot that folds into the home).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const parentId = typeof body?.parentId === 'string' ? body.parentId.trim() : ''
  if (!parentId) return NextResponse.json({ error: 'parentId required' }, { status: 400 })
  try {
    const result = await linkBookingBundle(params.id, parentId, session.email)
    if (!result.ok) return NextResponse.json({ error: result.error, result }, { status: 400 })
    return NextResponse.json({ ok: true, result })
  } catch (e: any) {
    console.error('POST /api/admin/[id]/bundle error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  try {
    const result = await unlinkBookingBundle(params.id, session.email)
    if (!result.ok) return NextResponse.json({ error: result.error, result }, { status: 400 })
    return NextResponse.json({ ok: true, result })
  } catch (e: any) {
    console.error('DELETE /api/admin/[id]/bundle error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
