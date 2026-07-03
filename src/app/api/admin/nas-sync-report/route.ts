import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { buildNasReport, latestNasState, verifyNasMirror } from '@/lib/nas-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/admin/nas-sync-report — the "ตรวจตอนนี้" button. Uses the LATEST NAS
 * manifest (pushed by the Mac agent) and LIVE Drive counts per Production ID
 * (global code search — survives ops hand-moves). NAS = a transfer queue
 * (upload-then-delete), so: 🔄 = queue still draining, ✅ = queue drained &
 * files on Drive, ⏳ = nothing yet. Console access.
 *
 * GET ?verify=1 — v1.113.2 EXACT per-file check: diff every NAS file
 * (basename+size) against the landing tree + code-matched Drive folders, so
 * "uploaded but not yet deleted from NAS" reads as match, not backlog. Slower
 * (walks each tree live) — for the explicit "ตรวจว่าเหมือนกัน 100%" ask.
 */
export async function GET(request: NextRequest) {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }
  try {
    const { manifest, statuses } = await latestNasState()
    if (!manifest) {
      return NextResponse.json({ ok: false, reason: 'ยังไม่มีข้อมูลจาก NAS agent — ตรวจว่า agent บนเครื่อง admin ทำงานอยู่' }, { status: 200 })
    }
    if (request.nextUrl.searchParams.get('verify') === '1') {
      const mirror = await verifyNasMirror(manifest)
      return NextResponse.json({ ok: true, nasAt: manifest.at ?? null, ...mirror })
    }
    const report = await buildNasReport(manifest, { withDriveCounts: true, statuses })
    return NextResponse.json({ ok: true, ...report })
  } catch (e: any) {
    console.error('GET /api/admin/nas-sync-report error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
