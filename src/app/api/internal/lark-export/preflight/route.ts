/**
 * GET /api/internal/lark-export/preflight[?write=1]
 *
 * v1.212 — "is the Lark side actually set up?"
 *
 * Everything this integration depends on lives outside the repo: a self-built
 * app, its approved scopes, and whether a human shared the target folder and
 * Base with that app. None of it can be verified by reading code, and getting
 * it wrong fails at 23:00 with nobody watching. So: one endpoint that tries the
 * real calls and reports, in Thai, exactly which step is missing.
 *
 * Default is READ-ONLY (token + list Base tables). `?write=1` additionally
 * uploads a tiny probe file, which is the only way to prove the Drive folder is
 * shared with the app — an app can hold the drive scope and still be unable to
 * write to a folder nobody shared with it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { larkPreflight } from '@/lib/lark-export'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const allowed =
    internalSecretAllowed(request, 'x-lark-export-secret',
      ['LARK_EXPORT_SECRET', 'BACKUP_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']) ||
    (await getSession())?.role === 'ADMIN'
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const write = new URL(request.url).searchParams.get('write') === '1'
  try {
    return NextResponse.json(await larkPreflight({ write }))
  } catch (e: any) {
    console.error('[lark-export] preflight error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
