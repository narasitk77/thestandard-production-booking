import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runVideoMerge, rememberCardHoldsPosted } from '@/lib/video-merge'
import { recordHeartbeat } from '@/lib/heartbeat'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { notifyChat } from '@/lib/notify'
import { CARD_HOLD_FIX } from '@/lib/reconciler/guards'
import { runGuard, MERGE_LOCK_MAX_MS } from '@/lib/merge-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // walking + moving footage across folders can take a while

// v1.146 review fix — a proxy-timeout-driven retry (browser sees an error and
// re-fires while the server keeps running) must not overlap two real passes:
// the underlying ensureFolderPath/ensureChildFolder Drive primitives are
// non-atomic, so two concurrent runs can fork duplicate box/camera folders.
// Single container deployment, so module-level state is enough — mirrors the
// guard already used in sound-staging-restructure/route.ts. dryRun reads are
// never gated.
// maint 2026-11-08 — the guard EXPIRES (a boolean latched forever on one hung Drive call; see runGuard), but only
// after MERGE_LOCK_MAX_MS: it recovers from a hang, it never lets a slow live pass be overlapped by the next one.
const guard = runGuard('video-merge', MERGE_LOCK_MAX_MS)

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
async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  if (internalSecretAllowed(request, 'x-video-merge-secret',
    ['VIDEO_MERGE_SECRET', 'SOUND_MERGE_SECRET', 'NAS_MANIFEST_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return { ok: true, isWorker: true }
  const session = await getSession()
  return { ok: session?.role === 'ADMIN', isWorker: false }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  const onlyCode = searchParams.get('code')?.trim() || undefined
  // v1.127 — ?notify=1 (the NAS-sync-gated worker sends this): Discord-ping the
  // result, but only when something actually moved or failed — no-op runs stay quiet.
  const notify = searchParams.get('notify') === '1'

  let token = 0
  if (!dryRun) {
    token = guard.start()
    if (!token) return NextResponse.json({ error: 'video-merge กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
  }
  try {
    const result = await runVideoMerge({ dryRun, onlyCode })
    // maint 2026-11-08 — the dead-man heartbeat = "the scheduled sweep ran and could do its job". A skipped run
    // (env unset / landing unreadable) merged nothing, a ?code= run walked one booking, and an admin click must
    // not stand in for a dead worker (the shoot-markers rule) — none of them tick it.
    if (!dryRun && result.skipped) console.error(`[video-merge] run failed: skipped — ${result.reason}`)
    if (allowed.isWorker && !dryRun && !onlyCode && !result.skipped) await recordHeartbeat('video-merge').catch(() => {})
    // v1.280 — a run that only HELD cards (moved nothing) must not stay quiet — but a hold persists until a
    // human moves the card, so post it only when the team has not been given this held SET (cardHoldsChatDue);
    // ops keeps alertOps' 6 h repeat
    if (notify && !dryRun && !result.skipped && (result.moved + result.movedFolders > 0 || result.errors > 0 || result.cardHoldsChatDue)) {
      const delivered = await notifyChat(
        `🎬 NAS sync เขียวแล้ว → รวมไฟล์วิดีโอ: ย้าย ${result.moved} ไฟล์ + ${result.movedFolders} โฟลเดอร์` +
        ` (${result.bookings} งาน${result.errors ? ` · ⚠️ error ${result.errors}` : ''})` +
        (result.cardHoldsChatDue ? `\n⛔ ค้าง ${result.cardHolds.length} การ์ด — ${CARD_HOLD_FIX}:\n  ${result.cardHolds.slice(0, 8).join('\n  ')}` : ''),
      ).catch((e: any) => { console.error('[video-merge] notifyChat threw:', e?.message || e); return false })
      // the set is recorded only once the team actually HAS it — a failed post is retried next run
      if (!delivered) console.error(`[video-merge] แชตทีม 🎬 ส่งไม่ถึงช่องไหนเลย${result.cardHoldsChatDue ? ' — รายการการ์ดค้างจะโพสต์ใหม่รอบหน้า' : ''}`)
      else if (result.cardHoldsChatDue) await rememberCardHoldsPosted(result.cardHolds)
    }
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('GET /api/internal/video-merge/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  } finally {
    if (token) guard.end(token)
  }
}
