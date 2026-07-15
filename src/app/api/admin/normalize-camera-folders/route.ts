import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { runCameraFolderNormalize } from '@/lib/camera-folder-normalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Same reentrancy guard as the other Drive-mutating admin sweeps.
let normalizeRunning = false

/**
 * POST /api/admin/normalize-camera-folders   { execute?: true }
 *
 * v1.147.3 — rename non-canonical camera folders ("Cam A", "cam-b", "Audio")
 * to the canonical vocab (CAM-A.., AUDIO, DRONE, SWITCHER, PHOTO, SCREEN)
 * across the VIDEO + Production Team shared drives. dryRun by default —
 * returns the full rename plan + collisions without touching Drive.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const execute = body?.execute === true

  if (execute) {
    if (normalizeRunning) return NextResponse.json({ error: 'normalize กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อน' }, { status: 409 })
    normalizeRunning = true
  }
  try {
    const result = await runCameraFolderNormalize({ dryRun: !execute })
    return NextResponse.json({ success: true, ...result })
  } catch (e: any) {
    console.error('POST /api/admin/normalize-camera-folders error:', e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  } finally {
    if (execute) normalizeRunning = false
  }
}
