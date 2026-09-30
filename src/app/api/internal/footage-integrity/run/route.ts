import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { scanFootagePage, formatRunSummary, isNews, type BoxCheck } from '@/lib/footage-integrity'
import { markFootageCheckAnnounced } from '@/lib/google-drive'
import { notifyChatDetailed } from '@/lib/notify'
import { alertOps } from '@/lib/ops-alert'
import { recordHeartbeat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * v1.221 — the "is the footage any good?" pass. v1.253 — the daily footage check
 * (MEDIAPOOL-CHECK as code) + the per-box `_FOOTAGE-CHECK` Doc.
 *
 *   GET  ?days=30&offset=0&limit=25[&codes=A,B][&projects=PP-26-034][&docs=1]
 *        One page. Never notifies. `docs=1` writes the Docs; without it every
 *        read and decision still runs and the result says `would-*` (dry run).
 *   POST { boxes, noBox, noBoxCodes, since, until, docs, failure? }
 *        The worker's end-of-run summary: ONE chat message for all pages, the
 *        stranded-in-trash alert, the heartbeat tick, and — only after a chat
 *        channel accepted the message — "announced" marks on the Docs, so an
 *        issue that never reached anyone is announced again tomorrow.
 *
 * Auth uses internalSecretAllowed (accepts ANY configured secret) rather than
 * the older `A || B || C` single-chain style. That chain is what silently 401'd
 * the landing cron for 13 days after a NEXTAUTH_SECRET rotation — a new route
 * should not inherit that trap.
 */
async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  if (internalSecretAllowed(request, 'x-footage-integrity-secret',
    ['REMINDERS_SECRET', 'PREP_FOLDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) {
    return { ok: true, isWorker: true }
  }
  const session = await getSession()
  return { ok: session?.role === 'ADMIN', isWorker: false }
}

const list = (v: string | null) => (v || '').split(',').map(s => s.trim()).filter(Boolean)

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const num = (k: string) => (url.searchParams.get(k) != null ? Number(url.searchParams.get(k)) : undefined)
  try {
    const page = await scanFootagePage({
      days: num('days'), offset: num('offset'), limit: num('limit'),
      codes: list(url.searchParams.get('codes')), projects: list(url.searchParams.get('projects')),
      docs: url.searchParams.get('docs') === '1',
    })
    return NextResponse.json({ success: true, ...page })
  } catch (e: any) {
    console.error('GET /api/internal/footage-integrity/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }
  if (!Array.isArray(body?.boxes)) return NextResponse.json({ error: 'boxes[] required' }, { status: 400 })
  const quiet = new URL(request.url).searchParams.get('quiet') === '1'
  const boxes = (body.boxes as BoxCheck[]).filter(b => b && typeof b.bookingCode === 'string' && b.doc && Array.isArray(b.errors))
  const failure = typeof body.failure === 'string' ? body.failure : null
  const docs = body.docs === true
  const noBox = Number(body.noBox) || 0
  const noBoxCodes = Array.isArray(body.noBoxCodes) ? body.noBoxCodes.filter((c: unknown) => typeof c === 'string').slice(0, 10) : []

  try {
    const text = formatRunSummary({ boxes, noBox, noBoxCodes, since: body.since, until: body.until, docs, failure })
    // Per-channel results, not one boolean — "sent" must mean a channel took it.
    const chat = text && !quiet ? await notifyChatDetailed(text, 'footage') : null
    if (chat && !chat.any) console.error('[footage-integrity] run failed: summary reached no chat channel')

    const ops: Record<string, unknown> = {}
    if (!quiet) {
      const stranded = boxes.filter(b => b.stranded)
      if (stranded.length) {
        ops.stranded = await alertOps('footage-stranded', 'ต้นฉบับค้างในถังขยะ — Production Booking',
          `ไฟล์ฟุตเทจค้างในโฟลเดอร์ drop ที่ถูกทิ้ง (ถังขยะลบถาวรใน ~30 วัน): ${stranded.map(b => `${b.bookingCode} ${b.stranded!.files} ไฟล์`).join(' · ')}`)
      }
      // The heartbeat below says "the worker is alive"; a broken or unheard run must still reach ops.
      if (allowed.isWorker && failure) {
        ops.incomplete = await alertOps('footage-integrity', 'ตรวจฟุตเทจรายวันไม่ครบ — Production Booking',
          `ตรวจฟุตเทจรายวันไม่ครบ: ${failure} · ตรวจได้ ${boxes.length} กล่อง`)
      }
      if (allowed.isWorker && chat && !chat.any) {
        ops.undelivered = await alertOps('footage-integrity-undelivered', 'สรุปตรวจฟุตเทจส่งไม่ถึงแชต — Production Booking',
          'สรุปตรวจฟุตเทจรายวันส่งไม่ถึงช่องแชตไหนเลย (Discord/Lark) — ดู log [footage-integrity]')
      }
    }

    // Mark what was announced ONLY after delivery. A box whose issues cleared is marked
    // too (nothing to deliver), so the same issue coming back later is news again.
    let marked = 0
    let markFailed = 0
    if (docs && !quiet) {
      const delivered = !!chat?.any
      for (const b of boxes) {
        if (!b.doc.id || typeof b.issueKey !== 'string' || b.doc.announced === b.issueKey || b.state === 'unreadable') continue
        if (isNews(b) ? !delivered : b.state === 'issues') continue
        try { await markFootageCheckAnnounced(b.doc.id, b.issueKey); marked++ }
        catch (e: any) { markFailed++; console.error(`[footage-integrity] mark announced ${b.bookingCode} failed (will re-announce):`, e?.message || e) }
      }
    }

    if (allowed.isWorker) {
      const issues = boxes.filter(b => b.state === 'issues').length
      await recordHeartbeat('footage-integrity',
        `${issues}/${boxes.length}${noBox ? ` nobox=${noBox}` : ''}${failure ? ' INCOMPLETE' : ''} discord=${chat?.discord ?? '-'} lark=${chat?.lark ?? '-'}`)
    }
    return NextResponse.json({ success: true, report: text || null, chat, ops, marked, markFailed })
  } catch (e: any) {
    console.error('POST /api/internal/footage-integrity/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
