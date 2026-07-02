import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
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
function expectedSecret(): string | undefined {
  return process.env.NAS_MANIFEST_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}

async function isAllowed(request: NextRequest): Promise<boolean> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-nas-secret')?.trim()
  if (secret && headerSecret === secret) return true
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
      folders: body.folders.map(f => ({
        name: String(f.name || ''),
        files: (f.files || []).map(x => ({ p: String(x.p || ''), size: Number(x.size) || 0 })),
      })),
    })
    return NextResponse.json({ ok: true, completeCount: report.completeCount, totalFolders: report.totalFolders })
  } catch (e: any) {
    console.error('POST /api/internal/nas-manifest error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
