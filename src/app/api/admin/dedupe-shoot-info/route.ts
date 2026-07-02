import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { dedupeShootInfoFiles } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/admin/dedupe-shoot-info  { folderId, apply? }
 *
 * v1.111 — one-off cleanup: collapse duplicate "_SHOOT*.txt" booking-info files
 * in a Drive folder to 1 per name (keeps the newest, TRASHES the rest — recoverable).
 * A pre-fix non-idempotent write / parallel-upload race left several per booking.
 * dryRun default; { apply: true } performs the trash. Admin-only.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const folderId = String(body?.folderId || '').trim()
    const apply = body?.apply === true
    if (!folderId) return NextResponse.json({ error: 'folderId is required' }, { status: 400 })

    const result = await dedupeShootInfoFiles(folderId, { dryRun: !apply })
    return NextResponse.json({ ok: true, dryRun: !apply, ...result })
  } catch (e: any) {
    console.error('POST /api/admin/dedupe-shoot-info error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
