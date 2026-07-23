import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runFolderIntegrity, maybeSendDailyDigest } from '@/lib/folder-integrity'
import { sendEmail } from '@/lib/email'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Reentrancy guard — timestamp + expiry, not a boolean (the v1.149/v1.150
// lesson: a request that dies without reaching `finally` must not latch the
// guard forever and silently 409 every later run).
let integrityRunningSince: number | null = null
const GUARD_MAX_MS = 15 * 60 * 1000

// v1.151.3 — digest de-duplication. In report-only mode the same drift is
// found every hour, so mailing every run would send ops an identical letter 24
// times a day and the whole thing gets filtered within two days — exactly the
// alert-fatigue that makes a monitoring system useless. Mail when the picture
// CHANGES, plus a heartbeat digest at most once every 12h so silence still
// means "checked and unchanged", never "worker died".
let lastDigestKey: string | null = null
let lastDigestAt = 0
const DIGEST_HEARTBEAT_MS = 12 * 60 * 60 * 1000

/**
 * GET /api/internal/folder-integrity/run
 *   ?dryRun=0            apply (DEFAULT IS DRY RUN — report only)
 *   &code=<ProductionID> scope to one booking
 *   &pastDays= &futureDays= &limit= &maxWrites=   window + budgets
 *   &report=1            force the digest email even from a dry run
 *
 * v1.151 — the standing folder check-and-repair pass. Supervised worker calls
 * it with the shared secret; an ADMIN session can also trigger it from the
 * browser (dry run) to see what it WOULD fix.
 */
function expectedSecret(): string | undefined {
  return process.env.PREP_FOLDERS_SECRET?.trim()
    || process.env.NEXTAUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
}
function reportEmail(): string {
  return process.env.FOLDER_INTEGRITY_REPORT_EMAIL?.trim()
    || process.env.FEEDBACK_EMAIL?.trim()
    || 'narasit.k@thestandard.co'
}

async function isAllowed(request: NextRequest): Promise<{ ok: boolean; isWorker: boolean }> {
  const secret = expectedSecret()
  const header = request.headers.get('x-reconcile-secret')?.trim() || request.headers.get('x-prep-folders-secret')?.trim()
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (secret && (header === secret || bearer === secret)) return { ok: true, isWorker: true }
  const session = await getSession()
  if (session?.role === 'ADMIN') return { ok: true, isWorker: false }
  return { ok: false, isWorker: false }
}

const num = (v: string | null): number | undefined => {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export async function GET(request: NextRequest) {
  const allowed = await isAllowed(request)
  if (!allowed.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = new URL(request.url).searchParams
  const dryRun = !(sp.get('dryRun') === '0' || sp.get('dryRun') === 'false')
  const forceReport = sp.get('report') === '1'

  if (!dryRun) {
    if (integrityRunningSince && Date.now() - integrityRunningSince < GUARD_MAX_MS) {
      return NextResponse.json({ error: 'folder-integrity กำลังทำงานอยู่แล้ว — รอให้เสร็จก่อน' }, { status: 409 })
    }
    integrityRunningSince = Date.now()
  }
  try {
    const r = await runFolderIntegrity({
      dryRun,
      onlyCode: sp.get('code')?.trim() || undefined,
      pastDays: num(sp.get('pastDays')),
      futureDays: num(sp.get('futureDays')),
      limit: num(sp.get('limit')),
      maxWrites: num(sp.get('maxWrites')),
    })

    // epDuplicatesFound is a FINDING, not a repair — counting it as "แก้ N"
    // would tell ops something was fixed when nothing was touched.
    const { epDuplicatesFound, ...repaired } = r.fixed
    const changed = Object.values(repaired).reduce((n, v) => n + v, 0)
    // Report on worker runs in BOTH modes — the report-only stage is the whole
    // point of the rollout, and its digest is what earns the apply flag.
    const worth = changed > 0 || epDuplicatesFound > 0 || r.warnings.length > 0 || r.errors.length > 0
    // An APPLIED repair is always news; a report-only run is news only when the
    // picture differs from the last letter (or the 12h heartbeat is due).
    const digestKey = JSON.stringify({ f: r.fixed, w: [...r.warnings].sort(), e: r.errors.map(e => e.code).sort() })
    const stale = Date.now() - lastDigestAt > DIGEST_HEARTBEAT_MS
    const newsworthy = !dryRun ? changed > 0 || r.errors.length > 0 : (digestKey !== lastDigestKey || stale)
    if ((allowed.isWorker && worth && newsworthy) || forceReport) {
      lastDigestKey = digestKey
      lastDigestAt = Date.now()
      const text = [
        `Folder integrity — ตรวจ ${r.checked}/${r.scanned} งาน${r.dryRun ? ' (DRY RUN)' : ''}`,
        '',
        `สร้าง box ที่หาย        : ${r.fixed.boxCreated}`,
        `เปลี่ยนชื่อ box ให้ตรง   : ${r.fixed.boxRenamed}`,
        `สร้างโฟลเดอร์ EP        : ${r.fixed.epCreated}`,
        `เปลี่ยนชื่อ EP ให้ตรง    : ${r.fixed.epRenamed}`,
        `สร้างช่องกล้อง/เสียง     : ${r.fixed.camCreated}`,
        `แก้ชื่อกล้องให้เป็นมาตรฐาน: ${r.fixed.camNormalized}`,
        `ซ่อม drop zone          : ${r.fixed.landingRepaired} (เปลี่ยนชื่อ ${r.fixed.landingRenamed})`,
        `ผูก id กลับให้ booking   : ${r.fixed.linksHealed}`,
        // Loudest line in the digest: this one means footage may be split.
        r.fixed.epDuplicatesFound
          ? `\n⚠️ พบโฟลเดอร์ EP ซ้ำ ${r.fixed.epDuplicatesFound} อัน — ไฟล์อาจกระจายอยู่คนละที่ (ดูรายการด้านล่าง)`
          : '',
        r.deferred ? `\nยกไปรอบหน้า: ${r.deferred} งาน (ชนเพดานต่อรอบ)` : '',
        r.warnings.length ? `\n── ต้องดูเอง (${r.warnings.length}) ──\n${r.warnings.slice(0, 40).join('\n')}` : '',
        r.errors.length ? `\n── error (${r.errors.length}) ──\n${r.errors.slice(0, 20).map(e => `${e.code}: ${e.error}`).join('\n')}` : '',
        r.actions.length ? `\n── รายละเอียด ──\n${r.actions.slice(0, 80).join('\n')}` : '',
      ].filter(Boolean).join('\n')
      try {
        await sendEmail({
          to: reportEmail(),
          subject: `[Folders]${r.fixed.epDuplicatesFound ? ` ⚠️ EP ซ้ำ ${r.fixed.epDuplicatesFound} —` : ''} ตรวจโครงสร้าง — แก้ ${changed} · เตือน ${r.warnings.length}${r.dryRun ? ' (dry run)' : ''}`,
          text,
          html: text.replace(/\n/g, '<br>'),
        })
      } catch (e: any) {
        console.error('[folder-integrity] report email failed (non-fatal):', e?.message || e)
      }
    }
    // v1.153 — once a day, post "what did the folder worker do" to Discord.
    // Worker runs only, and best-effort: a digest failure must not fail the run
    // that just repaired real folders.
    if (allowed.isWorker) {
      await maybeSendDailyDigest().catch(e =>
        console.error('[folder-integrity] daily digest failed (non-fatal):', e?.message || e))
    }
    return NextResponse.json(r)
  } catch (e: any) {
    console.error('GET /api/internal/folder-integrity/run error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  } finally {
    if (!dryRun) integrityRunningSince = null
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
