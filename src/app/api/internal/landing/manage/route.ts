import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { manageLandingFolders, pruneLandingToToday, ensureLandingForBooking } from '@/lib/landing-lifecycle'
import { sendEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// v1.146 review fix — same reentrancy guard as video-merge/sound-merge: a
// proxy-timeout-driven retry (or the nightly worker overlapping a manual
// call) must not overlap two real (non-dryRun) passes across ANY of this
// route's three operations (create / prune / sweep) — they all touch the
// same Production Team landing tree with non-atomic Drive primitives.
// v1.149 — timestamp instead of boolean: a request that dies without
// reaching `finally` (hung Drive call, killed process thread) must not
// latch the guard forever — that would 409 every nightly run silently
// (created=0 → no digest email, no audit row). Stale latches expire.
let landingManageRunningSince: number | null = null
const LANDING_GUARD_MAX_MS = 15 * 60 * 1000

/**
 * GET /api/internal/landing/manage?dryRun=1[&offset=1&keepDays=3&report=1]
 *
 * v1.139 — nightly landing drop-folder lifecycle: create the NEXT day's shoot
 * folders + trash past-empty ones so the Production Team drive stays lean.
 * Admin session or shared secret. dryRun defaults TRUE — pass dryRun=0 to apply.
 * The nightly worker emails a digest to LANDING_REPORT_EMAIL when anything changed.
 */
function expectedSecret(): string | undefined {
  return process.env.PREP_FOLDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}
function reportEmail(): string {
  return process.env.LANDING_REPORT_EMAIL?.trim() || process.env.FEEDBACK_EMAIL?.trim() || 'narasit.k@thestandard.co'
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actor: string | null; isWorker: boolean }> {
  const secret = expectedSecret()
  const headerSecret = request.headers.get('x-reconcile-secret')?.trim() || request.headers.get('x-prep-folders-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (headerSecret === secret || bearer === secret)) return { ok: true, actor: 'landing-worker', isWorker: true }
  const session = await getSession()
  if (session?.role === 'ADMIN') return { ok: true, actor: session.email, isWorker: false }
  return { ok: false, actor: null, isWorker: false }
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const dryRunParam = url.searchParams.get('dryRun')
  const dryRun = !(dryRunParam === '0' || dryRunParam === 'false')
  const createOffsetDays = url.searchParams.get('offset') != null ? Math.max(0, Number(url.searchParams.get('offset'))) : undefined
  const keepPastDays = url.searchParams.get('keepDays') != null ? Math.max(0, Number(url.searchParams.get('keepDays'))) : undefined
  const forceReport = url.searchParams.get('report') === '1'

  if (!dryRun) {
    if (landingManageRunningSince && Date.now() - landingManageRunningSince < LANDING_GUARD_MAX_MS) {
      return NextResponse.json({ error: 'landing กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อนแล้วลองใหม่' }, { status: 409 })
    }
    landingManageRunningSince = Date.now()
  }
  try {

  // v1.141 — create ONE booking's landing folder on demand: ?create=<code>
  // ("ขอเพิ่มพิเศษ" — a specific shoot, often past/completed, needs a drop target).
  const createCode = url.searchParams.get('create')?.trim()
  if (createCode) {
    try {
      const r = await ensureLandingForBooking(createCode, { dryRun })
      if (!dryRun && r.ok) {
        logAudit({
          actorEmail: allowed.actor || 'landing-create', action: 'drive.create_landing_for_booking',
          entityType: 'Drive', entityId: r.bookingCode, changes: { created: r.created, folderId: r.folderId },
        })
      }
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    } catch (e: any) {
      console.error('GET /api/internal/landing/manage create error:', e)
      return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
    }
  }

  // v1.140 — one-off prune: ?prune=today keeps ONLY today's shoot folders + any
  // ?keep=<name> (repeatable). Trashes only EMPTY non-today folders; footage +
  // manual folders are kept and reported. Used for a manual "clean the drop drive".
  if (url.searchParams.get('prune') === 'today') {
    const keepNames = url.searchParams.getAll('keep').map(s => s.trim()).filter(Boolean)
    try {
      const r = await pruneLandingToToday({ dryRun, keepNames })
      if (!dryRun && (r.trashed > 0 || r.errors > 0)) {
        logAudit({
          actorEmail: allowed.actor || 'landing-prune',
          action: 'drive.prune_landing_to_today',
          entityType: 'Drive', entityId: 'production-team',
          changes: { trashed: r.trashed, keptToday: r.keptToday, keptWithFiles: r.keptWithFiles.length, keptManual: r.keptManual.length, keepNames, errors: r.errors },
        })
      }
      return NextResponse.json(r)
    } catch (e: any) {
      console.error('GET /api/internal/landing/manage prune error:', e)
      return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
    }
  }

  try {
    const r = await manageLandingFolders({ dryRun, createOffsetDays, keepPastDays })
    const changed = r.created + r.removedPastEmpty
    if (!dryRun && (changed > 0 || r.createErrors > 0 || r.removeErrors > 0)) {
      logAudit({
        actorEmail: allowed.actor || 'landing-worker',
        action: 'drive.landing_lifecycle',
        entityType: 'Drive',
        entityId: 'production-team',
        changes: { targetDay: r.targetDay, created: r.created, removedPastEmpty: r.removedPastEmpty, keptRecent: r.keptRecent, createErrors: r.createErrors, removeErrors: r.removeErrors },
      })
    }
    const worth = changed > 0 || r.createErrors > 0 || r.removeErrors > 0
    if ((allowed.isWorker && worth) || forceReport) {
      const text = [
        `Landing lifecycle — ${r.targetDay}`,
        `สร้างโฟลเดอร์งานพรุ่งนี้ : ${r.created}${r.createErrors ? ` (error ${r.createErrors})` : ''}`,
        `ลบโฟลเดอร์ว่างที่จบแล้ว  : ${r.removedPastEmpty}${r.removeErrors ? ` (error ${r.removeErrors})` : ''}`,
        `คงไว้ (ยังใหม่/มีไฟล์)    : ${r.keptRecent}`,
        `keepPastDays = ${r.keepPastDays}`,
        '',
        ...r.actions.slice(0, 60),
      ].join('\n')
      try { await sendEmail({ to: reportEmail(), subject: `[Landing] ${r.targetDay} — สร้าง ${r.created} · ลบ ${r.removedPastEmpty}`, text, html: text.replace(/\n/g, '<br>') }) }
      catch (e: any) { console.error('[landing] report email failed (non-fatal):', e?.message || e) }
    }
    return NextResponse.json(r)
  } catch (e: any) {
    console.error('GET /api/internal/landing/manage error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
  } finally {
    if (!dryRun) landingManageRunningSince = null
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
