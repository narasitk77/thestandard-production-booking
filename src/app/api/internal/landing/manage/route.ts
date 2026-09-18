import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { manageLandingFolders, pruneLandingToToday, ensureLandingForBooking } from '@/lib/landing-lifecycle'
import { sendEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import { recordHeartbeat } from '@/lib/heartbeat'
import { notifyChat } from '@/lib/notify'
import { verifyLandingDuplicates, verdictLine } from '@/lib/landing-duplicates'

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
  // v1.222 — ?days=N widens the create window to N days ahead for this call
  // only (the steady-state value is LANDING_CREATE_DAYS in the stack env).
  const createDays = url.searchParams.get('days') != null ? Math.max(1, Number(url.searchParams.get('days'))) : undefined
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
      const stale = [...r.keptWithFiles, ...r.keptManual]
      if (!dryRun && (r.trashed > 0 || r.errors > 0 || stale.length > 0)) {
        // v1.220 — also log a run that trashed NOTHING but is sitting on a
        // backlog. The old condition (trashed || errors) wrote no row at all on
        // exactly the days that needed explaining: on 2026-09-09 the drive held
        // 10 folders neither pass is allowed to touch and there was no trace of
        // it anywhere.
        logAudit({
          actorEmail: allowed.actor || 'landing-prune',
          action: 'drive.prune_landing_to_today',
          entityType: 'Drive', entityId: 'production-team',
          changes: {
            trashed: r.trashed, keptToday: r.keptToday,
            keptWithFiles: r.keptWithFiles.length, keptManual: r.keptManual.length,
            keptFuture: r.keptFuture.length, staleNames: stale.slice(0, 40),
            keepNames, errors: r.errors,
          },
        })
      }
      // v1.220 — say the backlog out loud. keptWithFiles / keptManual are the
      // two classes BOTH passes are forbidden to trash (footage still inside,
      // or no Production ID to match), so they accumulate silently forever:
      // their names only ever existed in this HTTP response body, the digest
      // email printed them as a bare count, and no UI reads them. That is why
      // 10 folders — the oldest 16 days — piled up with nobody told.
      // 'footage' is the never-scope-filtered category, so this reaches Discord
      // and rides the v1.209 dual-send to Lark.
      if (!dryRun && allowed.isWorker && (stale.length > 0 || (r.keptNoFootage || []).length > 0)) {
        // เทียบ checksum เฉพาะโฟลเดอร์ที่ยังมีไฟล์ · จำกัดจำนวนเพราะแต่ละใบต้อง
        // เดิน Drive ทั้งต้นไม้ทั้งสองฝั่ง และ route นี้มีเพดาน 300 วิ
        // อ่านไม่สำเร็จ = ข้ามใบนั้นไป ไม่ทำให้รอบแจ้งเตือนล้ม
        const verdicts: string[] = []
        for (const d of (r.keptWithFilesDetail || []).slice(0, 6)) {
          if (!d.code) continue
          try { verdicts.push(verdictLine(await verifyLandingDuplicates(d.code, d.id))) }
          catch (e: any) { verdicts.push(`· ${d.code} — ตรวจ checksum ไม่สำเร็จ: ${e?.message || e}`) }
        }
        const show = stale.slice(0, 12).map(n => `• ${n}`)
        if (stale.length > show.length) show.push(`• …อีก ${stale.length - show.length} รายการ`)
        const text = [
          `🗂️ โฟลเดอร์ค้างในไดรฟ์ Production Team — ${stale.length} รายการ (ระบบลบเองไม่ได้)`,
          ...show,
          // v1.225 — เสียงดังที่สุดในข้อความนี้ เพราะมันแปลว่า "งานถ่ายไปแล้วแต่
          // ฟุตเทจยังไม่เคยมาถึง" ซึ่งยิ่งรู้ช้ายิ่งกู้ยาก (การ์ดถูกฟอร์แมตทับ)
          ...((r.keptNoFootage || []).length ? [
            '',
            `🚨 ${r.keptNoFootage.length} งานที่ถ่ายไปแล้วแต่ **ยังไม่มีฟุตเทจในกล่องเลย** — ไม่ทิ้งโฟลเดอร์ drop ไว้ให้`,
            ...r.keptNoFootage.slice(0, 8).map(k => `   • ${k.code} — ${k.reason}`),
            '   ตรวจที่ NAS/การ์ดกล้องก่อนฟอร์แมต',
          ] : []),
          '',
          // NOT simply "go press merge". On 2026-09-09 all five of these had
          // ALREADY merged: video-merge leaves a file in landing when the box
          // holds a twin with the same name AND size (video-merge.ts mirrorMove
          // → stats.dup++, "already in box — leave in landing"). The leftover
          // makes the folder non-empty, which makes it immortal to both cleanup
          // passes, forever. Pressing merge again is a no-op, so telling people
          // to press it is what keeps the loop closed.
          //
          // v1.220.1 — and do NOT tell anyone that dup>0 means "safe to delete".
          // v1.220 shipped exactly that sentence, and it is wrong in a way that
          // destroys footage: dup is decided on name+size ONLY. In
          // TSS-WYS-260824-01 all 585 files matched on name+size, yet
          // DSC04216.ARW differed in CONTENT — the landing copy is the real Sony
          // RAW (TIFF 49492A00) and the BOX copy is a JPEG-headed corrupt file,
          // and that RAW's md5 exists nowhere else. `moved=0 dup=585` is exactly
          // what that folder returns, so the old wording pointed a human
          // straight at the only good copy. Name+size is not identity; only a
          // checksum is. The app's service account does return md5Checksum.
          // v1.224 — เทียบ checksum ให้เลย แทนที่จะบอกว่า "ต้องไปเทียบ md5 เอง"
          // ข้อความเดิมถูกต้องแต่ทำอะไรต่อไม่ได้: คนอ่านแล้วก็ยังไม่รู้ว่าโฟลเดอร์ไหน
          // ลบได้ โฟลเดอร์ไหนห้ามแตะ — และการไปเทียบเองต้องเดิน Drive ทั้งต้นไม้
          ...(verdicts.length ? ['', 'ผลเทียบ checksum กับกล่อง VIDEO:', ...verdicts] : []),
          r.keptWithFiles.length && !verdicts.length
            ? `· ${r.keptWithFiles.length} โฟลเดอร์ยังมีไฟล์ = ยังไม่ได้ merge **หรือ** เป็นไฟล์ซ้ำที่ merge ไม่ยอมย้าย · ⚠️ dup>0 ไม่ได้แปลว่าลบได้ (เทียบแค่ชื่อ+ขนาด)` : '',
          r.keptManual.length ? `· ${r.keptManual.length} โฟลเดอร์ไม่มี Production ID = จับคู่กับใบจองไม่ได้ ต้องเปลี่ยนชื่อ/ย้ายด้วยมือ` : '',
          `(วันนี้เก็บไว้ ${r.keptToday} · ลบว่างไป ${r.trashed})`,
        ].filter(Boolean).join('\n')
        try { await notifyChat(text, 'footage') }
        catch (e: any) { console.error('[landing] stale-folder notify failed (non-fatal):', e?.message || e) }
      }
      // v1.220 — its OWN key, never 'landing'. The evening sweep and this noon
      // prune are different jobs with different failure modes; ticking
      // 'landing' here would let a healthy noon run hide a dead 19:00 worker,
      // which is precisely what the v1.172 note warns against. A separate key
      // gives the noon pass a dead-man of its own without that risk.
      if (!dryRun && allowed.isWorker) await recordHeartbeat('landing-prune', r.today)
      return NextResponse.json(r)
    } catch (e: any) {
      console.error('GET /api/internal/landing/manage prune error:', e)
      return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
    }
  }

  try {
    const r = await manageLandingFolders({ dryRun, createOffsetDays, createDays, keepPastDays })
    const changed = r.created + r.removedPastEmpty
    if (!dryRun && (changed > 0 || r.createErrors > 0 || r.removeErrors > 0)) {
      logAudit({
        actorEmail: allowed.actor || 'landing-worker',
        action: 'drive.landing_lifecycle',
        entityType: 'Drive',
        entityId: 'production-team',
        changes: { targetDay: r.targetDay, targetDayEnd: r.targetDayEnd, createDays: r.createDays, created: r.created, removedPastEmpty: r.removedPastEmpty, keptRecent: r.keptRecent, createErrors: r.createErrors, removeErrors: r.removeErrors },
      })
    }
    // Liveness tick for the nightly 19:00 landing worker — and only for it.
    // isWorker matters: the daily 12:00 landing-cleanup routine calls the
    // ?prune=today branch above, which returns earlier and must never forge a
    // tick for the evening sweep. An admin dry run must not either.
    if (allowed.isWorker && !dryRun) await recordHeartbeat('landing', r.targetDay)
    const worth = changed > 0 || r.createErrors > 0 || r.removeErrors > 0
    if ((allowed.isWorker && worth) || forceReport) {
      const text = [
        `Landing lifecycle — ${r.targetDay}${r.targetDayEnd !== r.targetDay ? ` → ${r.targetDayEnd}` : ''}`,
        `สร้างโฟลเดอร์งานล่วงหน้า ${r.createDays} วัน : ${r.created}${r.createErrors ? ` (error ${r.createErrors})` : ''}`,
        `ลบโฟลเดอร์ว่างที่จบแล้ว  : ${r.removedPastEmpty}${r.removeErrors ? ` (error ${r.removeErrors})` : ''}`,
        `คงไว้ (ยังใหม่/มีไฟล์)    : ${r.keptRecent}`,
        `keepPastDays = ${r.keepPastDays}`,
        '',
        ...r.actions.slice(0, 60),
      ].join('\n')
      try { await sendEmail({ to: reportEmail(), subject: `[Landing] ${r.targetDay}${r.targetDayEnd !== r.targetDay ? ` → ${r.targetDayEnd}` : ''} — สร้าง ${r.created} · ลบ ${r.removedPastEmpty}`, text, html: text.replace(/\n/g, '<br>') }) }
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
