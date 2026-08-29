/**
 * v1.211 — POST /api/internal/switcher/prefill
 *
 * ตะเข็บสำหรับปลายทางที่นัทวางไว้: ดูดข้อความสั่งงานจากกลุ่มไลน์มาตั้งเป็น
 * "แถวรอกรอก" ให้สวิตเชอร์เข้ามาเติมเวลา/ลิงก์ทีหลัง แทนที่จะต้องพิมพ์ชื่อหมาย
 * เองทุกครั้ง (และแทนที่จะไม่มีใครรู้ว่าวันนี้มีหมายอะไรบ้าง)
 *
 * ตัวอ่านไลน์ยัง **ไม่ได้ทำ** — endpoint นี้คือฝั่งรับ ซึ่งทดสอบได้เดี๋ยวนี้ด้วย
 * curl และเปลี่ยนต้นทางทีหลังได้โดยไม่ต้องแก้ที่นี่
 *
 * แถวที่สร้างจากที่นี่ **ไม่มี Production ID** โดยตั้งใจ — เลขออกตอนสวิตเชอร์
 * กดรับงานเท่านั้น ไม่งั้นหมายที่ไม่ได้เกิดขึ้นจริงจะกินเลขในลำดับไปเปล่า ๆ
 *
 *   curl -X POST https://probook.xtec9.xyz/api/internal/switcher/prefill \
 *     -H 'x-switcher-secret: <REMINDERS_SECRET>' -H 'content-type: application/json' \
 *     -d '{"dryRun":true,"jobs":[{"externalKey":"line:msg:123",
 *          "jobName":"ไลฟ์แถลงข่าว","workDate":"2026-08-29","outletCode":"NWS"}]}'
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { getOutlet } from '@/lib/data'
import { logAudit } from '@/lib/audit'
import { isValidISODate, isoDateToUTC } from '@/lib/switcher-jobs'

export const dynamic = 'force-dynamic'

const MAX_JOBS = 50
/** สังกัดตั้งต้นเมื่อต้นทางไม่รู้ว่าเป็นของช่องไหน — สวิตเชอร์เลือกใหม่ตอนรับงาน */
const DEFAULT_OUTLET = 'TSS'

async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-switcher-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

type Outcome = { key: string | null; jobName: string; result: 'created' | 'duplicate' | 'invalid'; reason?: string; id?: string }

export async function POST(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const dryRun = body?.dryRun === true || body?.dryRun === 1 || body?.dryRun === '1'
  const items = Array.isArray(body?.jobs) ? body.jobs : null
  if (!items) return NextResponse.json({ error: 'ต้องส่ง jobs เป็น array' }, { status: 400 })
  if (items.length > MAX_JOBS) {
    return NextResponse.json({ error: `ส่งได้สูงสุด ${MAX_JOBS} รายการต่อครั้ง` }, { status: 400 })
  }

  const outcomes: Outcome[] = []

  for (const raw of items) {
    const externalKey = String(raw?.externalKey ?? '').trim() || null
    const jobName = String(raw?.jobName ?? '').trim().slice(0, 200)
    const workDate = String(raw?.workDate ?? '').trim()
    const outletCode = String(raw?.outletCode ?? '').trim().toUpperCase() || DEFAULT_OUTLET

    if (!jobName) { outcomes.push({ key: externalKey, jobName, result: 'invalid', reason: 'ไม่มีชื่อหมาย' }); continue }
    if (!isValidISODate(workDate)) { outcomes.push({ key: externalKey, jobName, result: 'invalid', reason: 'วันที่ไม่ถูกต้อง' }); continue }
    if (!getOutlet(outletCode)) { outcomes.push({ key: externalKey, jobName, result: 'invalid', reason: `ไม่รู้จักสังกัด ${outletCode}` }); continue }

    // กันซ้ำสองชั้น: externalKey ถ้ามี (แม่นสุด) ไม่งั้นเทียบชื่อหมาย+วัน
    // ต้นทางที่อ่านข้อความซ้ำได้ต้องยิงซ้ำได้โดยไม่งอกแถว — ไม่งั้นรายการ
    // "รอกรอก" จะบวมจนคนเลิกดู แล้วฟีเจอร์ตามงานก็ตายไปด้วย
    const existing = await prisma.switcherJob.findFirst({
      where: externalKey
        ? { externalKey }
        : { jobName, workDate: isoDateToUTC(workDate), deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      outcomes.push({ key: externalKey, jobName, result: 'duplicate', id: existing.id })
      continue
    }

    if (dryRun) {
      outcomes.push({ key: externalKey, jobName, result: 'created' })
      continue
    }

    try {
      const created = await prisma.switcherJob.create({
        data: {
          outletCode,
          jobName,
          workDate: isoDateToUTC(workDate),
          requestedBy: String(raw?.requestedBy ?? '').trim().slice(0, 120) || null,
          notes: String(raw?.notes ?? '').trim().slice(0, 2000) || null,
          externalKey,
          source: 'LINE',
          status: 'DRAFT',
          // productionId / switcherEmail เว้นว่างจนกว่าจะมีคนรับงาน (ดูหัวไฟล์)
        },
        select: { id: true },
      })
      outcomes.push({ key: externalKey, jobName, result: 'created', id: created.id })
    } catch (e: any) {
      // ชน @unique externalKey แปลว่ามีอีก request สร้างไปแล้วระหว่างที่เราเช็ก
      // — ผลลัพธ์ที่ต้องการคือ "มีแถวนั้นอยู่" ซึ่งก็เป็นจริงแล้ว ไม่ใช่ error
      if (e?.code === 'P2002') {
        outcomes.push({ key: externalKey, jobName, result: 'duplicate' })
      } else {
        console.error('[switcher-prefill] create failed:', e?.message || e)
        outcomes.push({ key: externalKey, jobName, result: 'invalid', reason: 'สร้างไม่สำเร็จ' })
      }
    }
  }

  const created = outcomes.filter(o => o.result === 'created').length
  if (!dryRun && created > 0) {
    logAudit({
      actorEmail: 'system:switcher-prefill',
      action: 'SWITCHER_PREFILL',
      entityType: 'SwitcherJob',
      changes: { created, duplicate: outcomes.filter(o => o.result === 'duplicate').length, outcomes },
    })
  }

  return NextResponse.json({
    dryRun,
    created,
    duplicate: outcomes.filter(o => o.result === 'duplicate').length,
    invalid: outcomes.filter(o => o.result === 'invalid').length,
    outcomes,
  })
}
