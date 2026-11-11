import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { driftReport, renameEpisodeCode, autoApplyDrift } from '@/lib/episode-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * v1.286 — episode codes vs the Producer Dashboard (logic + why: src/lib/episode-sync.ts).
 *
 *   GET                              drift report. Read-only, always.
 *   POST { from, to, apply? }        rename one code on EVERY row that holds it (+ sheet col Q, _SHOOT.txt marker, audit).
 *                                    DRY RUN unless `apply: true`. `apply` present but not a boolean = 400
 *                                    (a string "true" must not quietly become a preview that looks like a write).
 *   POST { auto: true, apply? }      apply every unambiguous rename-candidate from the drift report.
 *                                    Writes only when `apply: true` AND the stack has EPISODE_SYNC_AUTOAPPLY=1
 *                                    (default OFF); otherwise it is a dry run and the answer carries a `note`
 *                                    and autoApplyEnabled:false. Top-level ok is false if ANY rename failed or was refused.
 *
 * Callers: scripts/hermes/probook-episode-drift.py (daily: read, then auto) and an operator via Portainer exec
 * (footage-check/audit-tools/call_internal.py <header> <path> [json-body] — a body makes it a POST).
 * No UI on purpose: nobody should be renaming codes by hand — the Dashboard is the source, this only follows it.
 *
 * STATUS CODES: a business refusal (blocked rename, Dashboard unreadable, sheet write failed) is HTTP 200
 * with `ok:false` + the reason — NOT 4xx/5xx. The operator tool reaches this over busybox `wget`, which throws
 * away the body of any non-2xx response, so the reason would vanish and the caller would see only
 * "wget failed". 401 = not allowed, 400 = malformed request, 500 = a crash we did not anticipate.
 * Never the other way round: a failure must not come back as ok:true.
 *
 * Auth: any configured internal secret (NOT NAS_MANIFEST_SECRET — the DSM box holds that one and has no
 * business renaming episodes) or an ADMIN session.
 */
async function caller(request: NextRequest): Promise<{ actor: string } | null> {
  if (internalSecretAllowed(request, 'x-episode-sync-secret', ['PREP_FOLDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) {
    return { actor: 'episode-sync' }
  }
  const session = await getSession()
  return session?.role === 'ADMIN' ? { actor: session.email } : null
}

export async function GET(request: NextRequest) {
  if (!(await caller(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await driftReport())
  } catch (e: any) {
    console.error('GET /api/internal/episode-sync/run error:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const who = await caller(request)
  if (!who) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 })
  if ('apply' in body && typeof body.apply !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'apply must be the JSON boolean true or false (got ' + JSON.stringify(body.apply) + ')' }, { status: 400 })
  }
  if (body.auto === true && ('from' in body || 'to' in body)) {
    return NextResponse.json({ ok: false, error: 'either { auto: true } or { from, to } — not both' }, { status: 400 })
  }
  try {
    if (body.auto === true) return NextResponse.json(await autoApplyDrift({ apply: body.apply === true, actor: who.actor }))
    if (typeof body.from !== 'string' || typeof body.to !== 'string' || !body.from.trim() || !body.to.trim()) {
      return NextResponse.json({ ok: false, error: 'need { from, to } (strings) or { auto: true }' }, { status: 400 })
    }
    return NextResponse.json(await renameEpisodeCode({ from: body.from, to: body.to, actor: who.actor, dryRun: body.apply !== true }))
  } catch (e: any) {
    console.error('POST /api/internal/episode-sync/run error:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'Failed' }, { status: 500 })
  }
}
