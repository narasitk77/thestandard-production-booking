import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { compareNasToDrive, latestNasManifest } from '@/lib/nas-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/admin/nas-sync-report — the "ตรวจ NAS ↔ Drive" button. Re-diffs the
 * LATEST stored NAS manifest (pushed by the Mac agent) against the Production
 * Team Drive folders right now. Includes the manifest timestamp so the UI can
 * show how fresh the NAS side is. Console access.
 */
export async function GET() {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }
  try {
    const manifest = await latestNasManifest()
    if (!manifest) {
      return NextResponse.json({ ok: false, reason: 'ยังไม่มีข้อมูลจาก NAS agent — ตรวจว่า agent บนเครื่อง admin ทำงานอยู่' }, { status: 200 })
    }
    const report = await compareNasToDrive(manifest)
    return NextResponse.json({ ok: true, ...report })
  } catch (e: any) {
    console.error('GET /api/admin/nas-sync-report error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
