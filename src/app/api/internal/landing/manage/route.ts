import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { manageLandingFolders, pruneLandingToToday, ensureLandingForBooking, cancelledLandingText, trashCancelledBookingFolders } from '@/lib/landing-lifecycle'
import { alertOps } from '@/lib/ops-alert'
import { sendEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import { recordHeartbeat } from '@/lib/heartbeat'
import { notifyChat } from '@/lib/notify'
import { verifyLandingDuplicates, verdictLine } from '@/lib/landing-duplicates'
import { prisma } from '@/lib/db'
import { expectsCameraVideo } from '@/lib/mediapro'

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
/**
 * maint 2026-11-08 — "ถ่ายแล้วแต่ฟุตเทจในกล่องยังไม่ครบ" is the loudest thing either pass knows (the card gets
 * formatted over it), yet it only ever rode notifyChat, whose result was dropped: no audit row, no ops alert, not in
 * the worker log, and the 19:00 sweep did not report it at all. One text, used by the chat, ops and the 19:00 email.
 */
function noFootageLines(list: Array<{ code: string; reason: string }>): string[] {
  if (!list.length) return []
  return [
    // v1.251 — รวมกรณี "ต้นฉบับยังมาไม่ครบ" ด้วย · หัวข้อต้องไม่บอกว่า "ไม่มีฟุตเทจเลย" ในเมื่อบางงานมี Sub แล้ว
    `🚨 ${list.length} งานที่ถ่ายไปแล้วแต่ **ฟุตเทจในกล่องยังไม่ครบ** — ไม่ทิ้งโฟลเดอร์ drop ไว้ให้`,
    ...list.slice(0, 8).map(k => `   • ${k.code} — ${k.reason}`),
    ...(list.length > 8 ? [`   • …อีก ${list.length - 8} งาน`] : []),
    '   ตรวจที่ NAS/การ์ดกล้องก่อนฟอร์แมต · ต้นฉบับที่ค้างอัปจะลงโฟลเดอร์ drop นี้ แล้วระบบย้ายเข้ากล่องเอง',
  ]
}

/**
 * maint r3 2026-11-08 — the ops alert (noon prune + 19:00 sweep) and the 19:00 email for keptNoFootage went out
 * every day for a list nobody can fix: a sound-only job's box never gets camera footage (boxFootageState said
 * 'no-footage' forever — since v1.285 a POSITIVELY sound-only job is trashed once real audio is in its box, so only an
 * audio-less one stays) and a box over the file cap reads 'unknown' forever. Now:
 *  - only bookings that expect camera video (expectsCameraVideo — cameraCount 0 / no camera crew = sound-only). This is
 *    still the LOOSE predicate (v1.285 left the alert alone): a Block Shot / no-crew / photographer-only booking whose
 *    video never arrives is left out of the alert too — an open decision, see docs/landing-folder-policy.md;
 *    a booking row that cannot be read stays IN (louder beats silent);
 *  - alert at once when a code appears that the last alert did not name, else repeat the same set every 48 h.
 *    Both passes share one key + one remembered set, so the 19:00 list (a subset of noon's) is not news again.
 * The noon team-chat post is unchanged (prod behaviour). Returns the filtered list + whether ops was alerted.
 */
const NO_FOOTAGE_SET_KEY = 'landing-no-footage-set'
const NO_FOOTAGE_SAME_SET_EVERY_MS = 48 * 3_600_000
async function alertNoFootage(list: Array<{ code: string; reason: string }>): Promise<{ list: Array<{ code: string; reason: string }>; alerted: boolean }> {
  if (!list.length) return { list, alerted: false }
  let soundOnly = new Set<string>()
  try {
    const rows = await prisma.booking.findMany({
      where: { bookingCode: { in: list.map(k => k.code) } },
      select: { bookingCode: true, cameraCount: true, crewRequired: true },
    })
    soundOnly = new Set(rows.filter(b => b.bookingCode && !expectsCameraVideo(b)).map(b => b.bookingCode!))
  } catch (e: any) {
    console.warn('[landing] could not read bookings to drop sound-only jobs — alerting on all of them:', e?.message || e)
  }
  const video = list.filter(k => !soundOnly.has(k.code))
  if (!video.length) return { list: video, alerted: false }
  const codes = [...new Set(video.map(k => k.code))].sort()
  let fresh = true
  try {
    const last = (await prisma.systemHeartbeat.findUnique({ where: { key: NO_FOOTAGE_SET_KEY } }))?.note
    if (last != null) { const named = new Set(last.split(',')); fresh = codes.some(c => !named.has(c)) }
  } catch (e: any) {
    console.warn('[landing] could not read the last no-footage set — treating this one as new:', e?.message || e)
  }
  const r = await alertOps('landing-no-footage', `ถ่ายแล้วแต่ฟุตเทจในกล่องยังไม่ครบ ${video.length} งาน — Production Booking`,
    noFootageLines(video).join('\n') + '\n(ชุดเดิมเตือนซ้ำทุก 48 ชม. · มีงานใหม่เข้ามา = เตือนทันที)',
    fresh ? 0 : NO_FOOTAGE_SAME_SET_EVERY_MS)
  if (r.attempted) {
    const at = new Date(), note = codes.join(',')
    try { await prisma.systemHeartbeat.upsert({ where: { key: NO_FOOTAGE_SET_KEY }, create: { key: NO_FOOTAGE_SET_KEY, at, note }, update: { at, note } }) }
    catch (e: any) { console.warn('[landing] could not remember the no-footage set (next pass alerts again):', e?.message || e) }
  }
  return { list: video, alerted: r.attempted }
}

function reportEmail(): string {
  return process.env.LANDING_REPORT_EMAIL?.trim() || process.env.FEEDBACK_EMAIL?.trim() || 'narasit.k@thestandard.co'
}

const LANDING_SECRET_KEYS = ['PREP_FOLDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET']

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; actor: string | null; isWorker: boolean }> {
  // maint 2026-11-08 — any configured secret, constant-time (was: the FIRST set of PREP_FOLDERS || NEXTAUTH || AUTH,
  // compared with === — a higher-precedence var the caller didn't know = silent 401s, the 13-day noon-prune outage)
  if (internalSecretAllowed(request, 'x-reconcile-secret', LANDING_SECRET_KEYS)
    || internalSecretAllowed(request, 'x-prep-folders-secret', LANDING_SECRET_KEYS)) {
    return { ok: true, actor: 'landing-worker', isWorker: true }
  }
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
      const noFootage = r.keptNoFootage || []
      // maint 2026-11-08 — null = no notice was due; false = it was due and reached no chat channel
      let chatDelivered: boolean | null = null
      if (!dryRun && (r.trashed > 0 || r.errors > 0 || stale.length > 0 || noFootage.length > 0)) {
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
            keptNoFootage: noFootage.length, noFootageCodes: noFootage.slice(0, 40).map(k => k.code),
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
      if (!dryRun && allowed.isWorker && (stale.length > 0 || noFootage.length > 0)) {
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
          ...(noFootage.length ? ['', ...noFootageLines(noFootage)] : []),
          ...(r.cancelledWithFiles.length ? ['', cancelledLandingText(r.cancelledWithFiles)] : []),
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
        // maint 2026-11-08 — keep the answer (notifyChat never throws; a dead webhook used to vanish here)
        try { chatDelivered = await notifyChat(text, 'footage') }
        catch (e: any) { chatDelivered = false; console.error('[landing] stale-folder notify failed (non-fatal):', e?.message || e) }
        if (!chatDelivered) console.error('[landing] stale-folder notice reached no chat channel (Discord/Lark) — see the drive.prune_landing_to_today audit row')
      }
      // maint 2026-11-08 — footage that never arrived reaches ops, not only through the team chat: alertOps writes
      // the ops.alert row the notify-feed relay forwards (r3: video jobs only, new set or every 48 h — alertNoFootage)
      if (!dryRun && allowed.isWorker && noFootage.length) await alertNoFootage(noFootage)
      if (!dryRun && allowed.isWorker && r.cancelledWithFiles.length) {
        await alertOps('landing-cancelled-files', 'ไฟล์ตกในโฟลเดอร์ drop ของงานที่ยกเลิก — Production Booking', cancelledLandingText(r.cancelledWithFiles))
      }
      // v1.220 — its OWN key, never 'landing'. The evening sweep and this noon
      // prune are different jobs with different failure modes; ticking
      // 'landing' here would let a healthy noon run hide a dead 19:00 worker,
      // which is precisely what the v1.172 note warns against. A separate key
      // gives the noon pass a dead-man of its own without that risk.
      if (!dryRun && allowed.isWorker) await recordHeartbeat('landing-prune', r.today)
      return NextResponse.json({ ...r, chatDelivered })
    } catch (e: any) {
      console.error('GET /api/internal/landing/manage prune error:', e)
      return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
    }
  }

  try {
    const r = await manageLandingFolders({ dryRun, createOffsetDays, createDays, keepPastDays })
    // v1.259 — cancelled bookings' own folders on the shared drives (box · staging · photo): empty → trash
    // Its own try: a failure here must not cost the landing sweep its audit row and heartbeat — but it must be loud.
    let cf: Awaited<ReturnType<typeof trashCancelledBookingFolders>>
    try { cf = await trashCancelledBookingFolders({ dryRun }) }
    catch (e: any) {
      console.error('[landing] cancelled-folders step failed:', e?.message || e)
      cf = { dryRun, trashed: [], keptWithFiles: [], skipped: [], errors: 1, actions: [`ERROR cancelled-folders step: ${e?.message || e}`] }
      if (!dryRun && allowed.isWorker) await alertOps('landing-cancelled-step', 'ทิ้งโฟลเดอร์งานที่ยกเลิกไม่สำเร็จ — Production Booking', `ขั้นทิ้งโฟลเดอร์ของงานที่ยกเลิก (กล่อง/staging/รูป) ล้ม: ${e?.message || e}`)
    }
    r.cancelledWithFiles.push(...cf.keptWithFiles)
    r.actions.push(...cf.actions)
    if (!dryRun && (cf.trashed.length || cf.errors)) {
      logAudit({
        actorEmail: allowed.actor || 'landing-worker', action: 'drive.trash_cancelled_booking_folders',
        entityType: 'Drive', entityId: 'cancelled-bookings',
        changes: { trashed: cf.trashed.slice(0, 60), keptWithFiles: cf.keptWithFiles.length, skipped: cf.skipped.slice(0, 20), errors: cf.errors },
      })
    }
    const changed = r.created + r.removedPastEmpty + cf.trashed.length
    const noFootage = r.keptNoFootage || []
    if (!dryRun && (changed > 0 || r.createErrors > 0 || r.removeErrors > 0 || noFootage.length > 0)) {
      logAudit({
        actorEmail: allowed.actor || 'landing-worker',
        action: 'drive.landing_lifecycle',
        entityType: 'Drive',
        entityId: 'production-team',
        changes: { targetDay: r.targetDay, targetDayEnd: r.targetDayEnd, createDays: r.createDays, created: r.created, removedPastEmpty: r.removedPastEmpty, keptRecent: r.keptRecent, createErrors: r.createErrors, removeErrors: r.removeErrors,
          keptNoFootage: noFootage.length, noFootageCodes: noFootage.slice(0, 40).map(k => k.code) },
      })
    }
    // Liveness tick for the nightly 19:00 landing worker — and only for it.
    // isWorker matters: the daily 12:00 landing-cleanup routine calls the
    // ?prune=today branch above, which returns earlier and must never forge a
    // tick for the evening sweep. An admin dry run must not either.
    if (allowed.isWorker && !dryRun) await recordHeartbeat('landing', r.targetDay)
    // v1.258 — files in a cancelled booking's drop folder are never merged: say it in chat, not only the email
    if (allowed.isWorker && !dryRun && r.cancelledWithFiles.length) {
      const warn = cancelledLandingText(r.cancelledWithFiles)
      try { await notifyChat(warn, 'footage') } catch (e: any) { console.error('[landing] cancelled-files notify failed (non-fatal):', e?.message || e) }
      await alertOps('landing-cancelled-files', 'ไฟล์ตกในโฟลเดอร์ drop ของงานที่ยกเลิก — Production Booking', warn)
    }
    // maint 2026-11-08 — a drop folder kept because the box has no camera footage is worth an email on its own
    // r3 — but only when ops was alerted for it (new set / 48 h), not every evening; sound-only jobs never count
    const nf = !dryRun && allowed.isWorker ? await alertNoFootage(noFootage) : { list: noFootage, alerted: false }
    const worth = changed > 0 || r.createErrors > 0 || r.removeErrors > 0 || cf.errors > 0 || r.cancelledWithFiles.length > 0 || nf.alerted
    if ((allowed.isWorker && worth) || forceReport) {
      const text = [
        ...(r.cancelledWithFiles.length ? [cancelledLandingText(r.cancelledWithFiles), ''] : []),
        ...(nf.list.length ? [...noFootageLines(nf.list), ''] : []),
        `Landing lifecycle — ${r.targetDay}${r.targetDayEnd !== r.targetDay ? ` → ${r.targetDayEnd}` : ''}`,
        `สร้างโฟลเดอร์งานล่วงหน้า ${r.createDays} วัน : ${r.created}${r.createErrors ? ` (error ${r.createErrors})` : ''}`,
        `ลบโฟลเดอร์ว่างที่จบแล้ว  : ${r.removedPastEmpty}${r.removeErrors ? ` (error ${r.removeErrors})` : ''}`,
        `ทิ้งโฟลเดอร์ว่างของงานที่ยกเลิก (กล่อง/staging/รูป): ${cf.trashed.length}${cf.errors ? ` (error ${cf.errors})` : ''}`,
        `คงไว้ (ยังใหม่/มีไฟล์)    : ${r.keptRecent}`,
        `keepPastDays = ${r.keepPastDays}`,
        '',
        ...r.actions.slice(0, 60),
      ].join('\n')
      try { await sendEmail({ to: reportEmail(), subject: `[Landing] ${r.targetDay}${r.targetDayEnd !== r.targetDay ? ` → ${r.targetDayEnd}` : ''} — สร้าง ${r.created} · ลบ ${r.removedPastEmpty}`, text, html: text.replace(/\n/g, '<br>') }) }
      catch (e: any) { console.error('[landing] report email failed (non-fatal):', e?.message || e) }
    }
    return NextResponse.json({ ...r, cancelledFolders: cf })
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
