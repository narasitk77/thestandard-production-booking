import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { buildNasReport, latestNasState } from '@/lib/nas-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/admin/nas-sync-report — the "ตรวจตอนนี้" button. Uses the LATEST NAS
 * manifest (pushed by the Mac agent) and LIVE Drive counts per Production ID
 * (global code search — survives ops hand-moves). NAS = a transfer queue
 * (upload-then-delete), so: 🔄 = queue still draining, ✅ = queue drained &
 * files on Drive, ⏳ = nothing yet. Console access.
 */
export async function GET() {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }
  try {
    const { manifest, statuses } = await latestNasState()
    if (!manifest) {
      return NextResponse.json({ ok: false, reason: 'ยังไม่มีข้อมูลจาก NAS agent — ตรวจว่า agent บนเครื่อง admin ทำงานอยู่' }, { status: 200 })
    }
    const report = await buildNasReport(manifest, { withDriveCounts: true, statuses })
    return NextResponse.json({ ok: true, ...report })
  } catch (e: any) {
    console.error('GET /api/admin/nas-sync-report error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
