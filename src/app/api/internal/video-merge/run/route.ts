import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runVideoMerge } from '@/lib/video-merge'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { notifyDiscord } from '@/lib/notify'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // walking + moving footage across folders can take a while

/**
 * v1.109 — Internal endpoint. MOVES NAS footage from the flat "Production Team"
 * landing folders into each booking's VIDEO 2026 box, keyed by Production ID,
 * mirroring the camera/EP subfolder tree. Auth: shared secret header
 * (x-video-merge-secret) or admin session — same pattern as sound-merge.
 *
 * v1.123 — accept ANY configured secret (internalSecretAllowed), same fix as
 * sound-merge: first-set-env-wins equality breaks whichever caller sends a
 * lower-precedence (but equally trusted) secret.
 *
 * GET /api/internal/video-merge/run[?dryRun=1][&code=<ProductionID>][&notify=1]
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-video-merge-secret',
    ['VIDEO_MERGE_SECRET', 'SOUND_MERGE_SECRET', 'NAS_MANIFEST_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  const onlyCode = searchParams.get('code')?.trim() || undefined
  // v1.127 — ?notify=1 (the NAS-sync-gated worker sends this): Discord-ping the
  // result, but only when something actually moved or failed — no-op runs stay quiet.
  const notify = searchParams.get('notify') === '1'
  try {
    const result = await runVideoMerge({ dryRun, onlyCode })
    if (!dryRun) await recordHeartbeat('video-merge').catch(() => {})
    if (notify && !dryRun && !result.skipped && (result.moved + result.movedFolders > 0 || result.errors > 0)) {
      await notifyDiscord(
        `🎬 NAS sync เขียวแล้ว → รวมไฟล์วิดีโอ: ย้าย ${result.moved} ไฟล์ + ${result.movedFolders} โฟลเดอร์` +
        ` (${result.bookings} งาน${result.errors ? ` · ⚠️ error ${result.errors}` : ''})`,
      ).catch(() => {})
    }
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/video-merge/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
