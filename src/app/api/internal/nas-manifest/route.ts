import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { ingestNasManifest, type NasManifest } from '@/lib/nas-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // diffs every landing folder against Drive

/**
 * POST /api/internal/nas-manifest — receive the NAS scan from the Mac agent
 * (scripts/nas-manifest-agent.sh, launchd every ~10 min), diff against the
 * Production Team Drive folders, store, and fire the sync-complete / daily
 * emails. Auth: shared secret header (x-nas-secret) or admin session — same
 * pattern as the other internal endpoints.
 */
// maint 2026-11-08 — any configured secret, constant-time (was first-set chain + ===).
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-nas-secret', ['NAS_MANIFEST_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function POST(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await request.json().catch(() => null) as NasManifest | null
    if (!body || !Array.isArray(body.folders)) {
      return NextResponse.json({ error: 'manifest { at, folders: [{name, files:[{p,size}]}] } required' }, { status: 400 })
    }
    // Defensive caps — a runaway agent must not stuff megabytes into the row.
    if (body.folders.length > 500) return NextResponse.json({ error: 'too many folders' }, { status: 400 })
    const totalFiles = body.folders.reduce((n, f) => n + (f.files?.length || 0), 0)
    if (totalFiles > 100000) return NextResponse.json({ error: 'too many files' }, { status: 400 })

    const report = await ingestNasManifest({
      at: body.at || new Date().toISOString(),
      host: body.host,
      // v1.288 — folders the agent could not read: not "gone from the NAS"
      ...(Array.isArray(body.skipped) ? { skipped: body.skipped.slice(0, 500).map(String) } : {}),
      folders: body.folders.map(f => ({
        name: String(f.name || ''),
        files: (f.files || []).map(x => ({ p: String(x.p || ''), size: Number(x.size) || 0 })),
        // v1.288 — MEDIAPRO read on the NAS (agent caps the same numbers; a runaway agent is cut here too)
        ...(f.truncated === true ? { truncated: true } : {}),
        ...(f.lastWrite != null && Number.isFinite(Number(f.lastWrite)) ? { lastWrite: Number(f.lastWrite) } : {}),
        ...(Array.isArray(f.cards) && f.cards.length ? {
          cards: f.cards.slice(0, 50).map(c => ({
            dir: String(c?.dir ?? ''),
            ...(Array.isArray(c?.origs) ? { origs: c.origs.slice(0, 3000).map(String) } : {}),
            ...(c?.error ? { error: String(c.error).slice(0, 300) } : {}),
          })),
        } : {}),
      })),
    })
    return NextResponse.json({ ok: true, sending: report.sendingCount, sent: report.sentCount, folders: report.folders.length })
  } catch (e: any) {
    console.error('POST /api/internal/nas-manifest error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
