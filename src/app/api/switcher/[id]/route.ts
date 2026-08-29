/**
 * v1.211 — PATCH/DELETE /api/switcher/[id]
 *
 * PATCH ทำสองอย่างในเส้นทางเดียว เพราะฝั่งข้อมูลมันคือการกระทำเดียวกัน:
 *   แก้แถวของตัวเอง                — เขียนทับฟิลด์ที่แก้ได้
 *   "รับงาน" แถว DRAFT ที่ระบบเตรียมไว้ — เติมเจ้าของ + ออก Production ID ให้
 *
 * DELETE เป็น soft delete: ทั้งรีโปนี้ไม่มีการลบถาวร และเลขที่ออกไปแล้วต้อง
 * ไม่ถูกใช้ซ้ำ (คนอาจก็อปไปแปะในชีท/ชื่อโฟลเดอร์ไปแล้ว) — mintSwitcherProductionId
 * จึงยังนับแถวที่ลบไปแล้วอยู่
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getSession, getSwitcherAccess } from '@/lib/session'
import { getOutlet } from '@/lib/data'
import { logAudit } from '@/lib/audit'
import {
  canEditSwitcherJob,
  idFieldsLocked,
  isoDateToUTC,
  utcDateToISO,
  validateSwitcherPayload,
} from '@/lib/switcher-jobs'
import { lockSwitcherSequence, mintSwitcherProductionId } from '@/lib/switcher-mint'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSwitcherAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const existing = await prisma.switcherJob.findUnique({ where: { id: params.id } })
    if (!existing || existing.deletedAt) {
      return NextResponse.json({ error: 'ไม่พบรายการนี้' }, { status: 404 })
    }
    const actor = { email: session.email, canEditAll: access.canEditAll }
    if (!canEditSwitcherJob(actor, existing)) {
      return NextResponse.json({ error: 'แก้ได้เฉพาะงานของตัวเอง' }, { status: 403 })
    }
    // แถว DRAFT ที่ยังไม่มีเจ้าของ ใครก็ "รับ" ได้ — แต่ต้องเป็นสวิตเชอร์จริง
    // (canEditSwitcherJob ปล่อยผ่านให้ทุกคนที่เปิดหน้าได้ เพราะมันไม่รู้จัก role)
    const claiming = !existing.switcherEmail
    if (claiming && !access.isSwitcher && !access.canEditAll) {
      return NextResponse.json({ error: 'เฉพาะทีมสวิตเชอร์เท่านั้นที่รับงานได้' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = validateSwitcherPayload(body, c => !!getOutlet(c))
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

    // ช่องที่ "ไม่ส่งมา" = ไม่แตะ · ช่องที่ส่งมาว่าง = ตั้งใจล้าง
    //
    // ถ้าเขียนทับทุกช่องเสมอ การยิง PATCH ที่ไม่ได้แนบ links (เช่น แก้เวลาผ่าน
    // สคริปต์/curl) จะลบลิงก์ที่ตามมาได้ยากทิ้งไปเงียบ ๆ — เจอตอนทดสอบจริง
    // ฟอร์มบนเว็บส่งครบทุกช่องอยู่แล้ว จึงยังล้างลิงก์ได้ตามปกติด้วยการส่ง []
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body || {}, k)

    // สังกัด + วันที่ประกอบเป็นตัวเลขไปแล้ว ห้ามแก้ ไม่งั้นแถวจะกลายเป็น
    // "เลขบอกวันหนึ่ง ข้อมูลบอกอีกวัน" ซึ่งคือ drift แบบเดียวกับที่โฟลเดอร์
    // ไดรฟ์เคยเป็น (v1.114) · กรอกผิดให้ลบแล้วเพิ่มใหม่ เลขเก่าไม่ถูกใช้ซ้ำ
    if (idFieldsLocked(existing)) {
      const currentDate = utcDateToISO(existing.workDate)
      if (parsed.outletCode !== existing.outletCode || parsed.workDate !== currentDate) {
        return NextResponse.json({
          error: `แก้สังกัด/วันที่ไม่ได้หลังออกเลข ${existing.productionId} แล้ว — ถ้ากรอกผิด ให้ลบรายการนี้แล้วเพิ่มใหม่`,
        }, { status: 400 })
      }
    }

    const job = await prisma.$transaction(async (tx) => {
      let productionId = existing.productionId
      if (!productionId) {
        // แถว DRAFT เพิ่งถูกกรอกครบ → ถึงคิวออกเลข (ก่อนหน้านี้ตั้งใจไม่ออก
        // ไม่งั้นงานที่ไม่มีจริงจะกินเลขในลำดับไปเปล่า ๆ)
        await lockSwitcherSequence(tx, parsed.outletCode, parsed.workDate)
        productionId = await mintSwitcherProductionId(tx, parsed.outletCode, parsed.workDate)
      }
      return tx.switcherJob.update({
        where: { id: existing.id },
        data: {
          productionId,
          outletCode: parsed.outletCode,
          jobName: parsed.jobName,
          workDate: isoDateToUTC(parsed.workDate),
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          endDayOffset: parsed.endDayOffset,
          links: (has('links') ? parsed.links : (existing.links ?? [])) as unknown as Prisma.InputJsonValue,
          requestedBy: has('requestedBy') ? parsed.requestedBy : existing.requestedBy,
          notes: has('notes') ? parsed.notes : existing.notes,
          switcherEmail: existing.switcherEmail || session.email,
          status: 'LOGGED',
        },
      })
    })

    logAudit({
      actorEmail: session.email,
      action: claiming ? 'SWITCHER_JOB_CLAIM' : 'SWITCHER_JOB_UPDATE',
      entityType: 'SwitcherJob',
      entityId: job.id,
      bookingCode: job.productionId,
      changes: {
        before: {
          jobName: existing.jobName,
          startTime: existing.startTime,
          endTime: existing.endTime,
          links: existing.links,
          requestedBy: existing.requestedBy,
          notes: existing.notes,
        },
        after: {
          jobName: job.jobName,
          startTime: job.startTime,
          endTime: job.endTime,
          links: job.links,
          requestedBy: job.requestedBy,
          notes: job.notes,
        },
      },
    })

    return NextResponse.json({ job })
  } catch (e) {
    console.error('PATCH /api/switcher/[id] error:', e)
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSwitcherAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const existing = await prisma.switcherJob.findUnique({ where: { id: params.id } })
    if (!existing || existing.deletedAt) {
      return NextResponse.json({ error: 'ไม่พบรายการนี้' }, { status: 404 })
    }
    if (!canEditSwitcherJob({ email: session.email, canEditAll: access.canEditAll }, existing)) {
      return NextResponse.json({ error: 'ลบได้เฉพาะงานของตัวเอง' }, { status: 403 })
    }

    await prisma.switcherJob.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    })

    logAudit({
      actorEmail: session.email,
      action: 'SWITCHER_JOB_DELETE',
      entityType: 'SwitcherJob',
      entityId: existing.id,
      bookingCode: existing.productionId,
      changes: { jobName: existing.jobName, workDate: utcDateToISO(existing.workDate) },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/switcher/[id] error:', e)
    return NextResponse.json({ error: 'ลบไม่สำเร็จ' }, { status: 500 })
  }
}
