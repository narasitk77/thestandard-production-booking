/**
 * v1.215 — PATCH/DELETE /api/mix/[id] — รับงาน เปลี่ยนสถานะ แก้รายละเอียด
 *
 * กฎ "ใครทำอะไรได้" ทั้งหมดอยู่ใน src/lib/mix-jobs.ts (บริสุทธิ์ + มีเทส) ที่นี่
 * เป็นแค่เปลือก HTTP — ห้ามตัดสินสิทธิ์เองในไฟล์นี้ ไม่งั้นกฎจะกระจายสองที่แล้ว
 * เลื่อนออกจากกัน ซึ่งเป็นวิธีที่บั๊กสิทธิ์เกิดทุกครั้ง
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getSoundAccess } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { mixEventData, mixStateOf } from '@/lib/mix-stats'
import {
  canEditMixJob, canDeleteMixJob, canClaimMixJob, canAssignMixJob, canSetMixStatus, canCloseMixJob, canSetDeliveryLink,
  canMoveMixDueDate, canRequestMixPostpone, canDecideMixPostpone, validateMixPostpone, bangkokDateKey,
  isMixStatus, isAssignableTo, normalizeHttpLink, validateMixJob, formatMixNumber,
  type MixActor, type MixStatus,
} from '@/lib/mix-jobs'
import { notifyMixAssigned, notifyMixDelivered, notifyMixPostponeRequested, notifyMixPostponeDecided } from '@/lib/mix-notify'
import { syncMixJobCalendar, mixCalendarAuditNote } from '@/lib/mix-calendar'
import { attachBookingProducer } from '@/lib/mix-targets'

export const dynamic = 'force-dynamic'

async function load(id: string) {
  return prisma.mixJob.findFirst({ where: { id, deletedAt: null } })
}

/**
 * v1.249 — เขียนได้เฉพาะเมื่อสถานะงาน (สถานะ/คนทำ/วันที่) ยังเป็นอย่างที่อ่านมา · สองคำขอพร้อมกัน (ส่งงาน ×
 * แจกใหม่) เดิมจบที่แถวผสมของทั้งสอง และประวัติสองแถวเล่าสถานะที่ไม่เคยมีจริง (ผู้ตรวจเจอ) · ตอนนี้คำขอที่มาทีหลัง
 * ได้ 409 ให้โหลดใหม่ — ปิด "รับงานซ้อน" ที่มีมาก่อน v1.249 ไปด้วย · ไม่เทียบ updatedAt เพราะการซิงก์ปฏิทิน
 * ก็แตะ updatedAt (จะ 409 ทั้งที่ไม่มีอะไรชน)
 */
function sameWorkState(existing: { id: string; status: string; assigneeEmail: string | null; dueDate: Date | null }) {
  return { id: existing.id, deletedAt: null, status: existing.status, assigneeEmail: existing.assigneeEmail, dueDate: existing.dueDate }
}

const CONFLICT = 'งานนี้เพิ่งถูกแก้โดยอีกคน — โหลดคิวใหม่แล้วลองอีกครั้ง'
const NO_POSTPONE = { postponeToDate: null, postponeReason: null, postponeRequestedBy: null, postponeRequestedAt: null }
const isNotFound = (e: unknown) => (e as { code?: string })?.code === 'P2025'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSoundAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const found = await load(params.id)
    if (!found) return NextResponse.json({ error: 'ไม่พบงานนี้' }, { status: 404 })
    // v1.256 — Producer ของใบจองที่ผูกไว้แก้คำขอได้ (canEditMixJob) · ชุดเดียวกับที่ GET ส่งให้การ์ด
    const [existing] = await attachBookingProducer([found])

    const actor: MixActor = {
      email: session.email,
      isSound: access.isSound,
      isCoordinator: access.isCoordinator,
      canEditAll: access.canEditAll,
    }
    const body = await request.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    const changes: Record<string, unknown> = {}

    // ── รับงาน ──────────────────────────────────────────────────────────────
    if (body.claim === true) {
      if (!canClaimMixJob(actor, existing)) {
        return NextResponse.json(
          { error: existing.assigneeEmail ? 'งานนี้มีคนรับไปแล้ว' : 'เฉพาะทีมเสียงเท่านั้นที่รับงานได้' },
          { status: 403 },
        )
      }
      data.assigneeEmail = session.email
      data.claimedAt = new Date()
      // รับงานแล้วยังอยู่ QUEUED ไม่มีความหมาย — เดินหน้าให้เลย
      if (existing.status === 'QUEUED') data.status = 'IN_PROGRESS'
      changes.claimedBy = session.email
    }

    // ── coordinator แจกงานให้ทีมงาน (เส้นทางหลักตามที่ operator ออกแบบ) ──────
    let assignedTo: string | null = null
    if (typeof body.assigneeEmail === 'string' && body.assigneeEmail.trim()) {
      if (!canAssignMixJob(actor, existing)) {
        return NextResponse.json(
          { error: 'เฉพาะ coordinator ของทีมเสียง (หรือแอดมิน) เท่านั้นที่แจกงานได้' },
          { status: 403 },
        )
      }
      // แจกได้เฉพาะคนใน roster จริง — แจกให้คนนอกทำให้ตัวเลขภาระงานทีมเสียงเพี้ยน
      const roster = await prisma.teamMember.findMany({
        where: { role: 'sound', active: true }, select: { email: true },
      })
      const target = body.assigneeEmail.trim()
      if (!isAssignableTo(target, roster.map(r => r.email))) {
        return NextResponse.json(
          { error: `${target} ไม่ได้อยู่ในทีมเสียง — เพิ่มที่ /admin/team ก่อน` },
          { status: 400 },
        )
      }
      data.assigneeEmail = target
      data.assignedByEmail = session.email
      data.claimedAt = existing.claimedAt ?? new Date()
      if (existing.status === 'QUEUED') data.status = 'IN_PROGRESS'
      assignedTo = target
      changes.assignedTo = target
    }

    // ── v1.217 ลิงก์ไฟล์ที่มิกซ์เสร็จ (ขาออก) ────────────────────────────────
    // รับแยกจาก status เพื่อให้ "แปะลิงก์ไว้ก่อน ค่อยกดปิดทีหลัง" ทำได้ ไม่บังคับ
    // ให้ทำสองอย่างพร้อมกันในคลิกเดียว
    let deliveryLinkIn: string | null = null
    if ('deliveryLink' in body) {
      if (!canSetDeliveryLink(actor, existing, body.status)) {
        return NextResponse.json({ error: 'ใส่ลิงก์ได้เฉพาะคนที่รับงานนี้ไว้ (หรือ Sound Admin ตอนส่งงานแทน)' }, { status: 403 })
      }
      const link = normalizeHttpLink(body.deliveryLink)
      if (body.deliveryLink && !link) {
        return NextResponse.json({ error: 'ลิงก์ไฟล์ต้องขึ้นต้นด้วย http:// หรือ https://' }, { status: 400 })
      }
      deliveryLinkIn = link
      data.deliveryLink = link
      changes.deliveryLink = !!link
    }

    // ── เปลี่ยนสถานะ ────────────────────────────────────────────────────────
    if (typeof body.status === 'string' && body.status !== existing.status) {
      if (!isMixStatus(body.status)) return NextResponse.json({ error: 'สถานะไม่ถูกต้อง' }, { status: 400 })
      const next = body.status as MixStatus
      if (!canSetMixStatus(actor, existing, next)) {
        return NextResponse.json({ error: 'เปลี่ยนสถานะนี้ไม่ได้' }, { status: 403 })
      }
      // v1.217 — ปิดงานได้ต่อเมื่อบอกแล้วว่าไฟล์อยู่ไหน · ข้อความบอกตรง ๆ ว่าต้องทำ
      // อะไร ไม่ใช่แค่ปฏิเสธ เพราะคนกดปุ่มนี้กำลังจะจบงาน ไม่ได้กำลังทำผิด
      if (next === 'DONE' && !canCloseMixJob(existing, deliveryLinkIn)) {
        return NextResponse.json(
          { error: 'ใส่ลิงก์ไฟล์ที่มิกซ์เสร็จก่อนปิดงาน — คนขอจะได้รู้ว่าไปหยิบที่ไหน ไม่ต้องมาถามซ้ำ' },
          { status: 400 },
        )
      }
      data.status = next
      // deliveredAt ผูกกับ DONE เสมอ — ตั้งเองแยกไม่ได้ ไม่งั้นวันที่ส่งกับสถานะ
      // จะเล่าคนละเรื่อง ซึ่งทำให้ตัวเลข "ส่งทันไหม" เชื่อไม่ได้
      data.deliveredAt = next === 'DONE' ? (existing.deliveredAt ?? new Date()) : null
      changes.status = { from: existing.status, to: next }
    }

    // ── v1.257 ขอเลื่อนกำหนดส่ง (คนถืองาน) → คนขอ/Producer ของใบอนุมัติ ──────
    // นัท 2 ต.ค. 2569: "ขอเลื่อนแล้วให้แจ้งไปให้คนจองอนุมัติ" · คนถืองานเลื่อนเองไม่ได้ (canMoveMixDueDate)
    let postpone: { toDate: string; reason: string } | null = null
    if (body.postpone !== undefined) {
      if (!canRequestMixPostpone(actor, existing)) {
        return NextResponse.json({ error: 'ขอเลื่อนได้เฉพาะคนที่ถูกแจกงานนี้ ระหว่างกำลังทำ' }, { status: 403 })
      }
      const p = validateMixPostpone(body.postpone, existing.dueDate, bangkokDateKey())
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      postpone = p.value
      data.postponeToDate = new Date(`${p.value.toDate}T00:00:00Z`)
      data.postponeReason = p.value.reason
      data.postponeRequestedBy = session.email
      data.postponeRequestedAt = new Date()
      changes.postponeRequested = p.value
    }

    // ── v1.257 อนุมัติ/ไม่อนุมัติคำขอเลื่อน ──────────────────────────────────
    let decided: { approved: boolean; toDate: string; requestedBy: string } | null = null
    if (body.postponeDecision === 'approve' || body.postponeDecision === 'reject') {
      if (!canDecideMixPostpone(actor, existing)) {
        return NextResponse.json(
          { error: 'อนุมัติได้เฉพาะคนขอหรือ Producer ของใบ (คนที่ขอเลื่อนอนุมัติของตัวเองไม่ได้) และต้องมีคำขอค้างอยู่' },
          { status: 403 },
        )
      }
      const pending = existing.postponeToDate!.toISOString().slice(0, 10)
      // คำขอถูกแทนด้วยวันใหม่ระหว่างที่คนอนุมัติเปิดการ์ดอยู่ = ห้ามอนุมัติวันที่เขาไม่เห็น
      if (body.postponeTo !== pending) return NextResponse.json({ error: CONFLICT }, { status: 409 })
      const approved = body.postponeDecision === 'approve'
      // กำหนดส่งถูกแก้ตรง ๆ หลังมีคำขอ (แอดมิน) → อนุมัติวันเก่าจะดึงกำหนดเข้ามาแทนที่จะเลื่อนออก
      if (approved && existing.dueDate && pending <= existing.dueDate.toISOString().slice(0, 10)) {
        return NextResponse.json({ error: 'คำขอเลื่อนนี้ไม่ได้อยู่หลังกำหนดส่งปัจจุบันแล้ว — ให้คนทำขอใหม่' }, { status: 409 })
      }
      if (approved) data.dueDate = existing.postponeToDate
      Object.assign(data, NO_POSTPONE)
      decided = { approved, toDate: pending, requestedBy: existing.postponeRequestedBy || '' }
      changes.postponeDecision = { approved, toDate: pending, requestedBy: existing.postponeRequestedBy, reason: existing.postponeReason }
    }

    // ── แก้รายละเอียด ───────────────────────────────────────────────────────
    const editing = ['title', 'dueDate', 'sourceLink', 'notes'].some(k => k in body)
    if (editing) {
      if (!canEditMixJob(actor, existing)) {
        return NextResponse.json(
          { error: 'แก้ได้เฉพาะคำขอของตัวเอง (หรือของใบจองที่คุณเป็น Producer) ที่ยังไม่มีคนรับ หรืองานที่ตัวเองรับไว้' },
          { status: 403 },
        )
      }
      if ('dueDate' in body && !canMoveMixDueDate(actor, existing)) {
        return NextResponse.json(
          { error: 'คนทำงานเลื่อนกำหนดส่งเองไม่ได้ — กด "ขอเลื่อน" ให้คนขอ/Producer อนุมัติ' },
          { status: 403 },
        )
      }
      // ตรวจซ้ำทั้งชุดโดยเอาของเดิมมาเป็นฐาน — ตรวจเฉพาะช่องที่ส่งมาจะทำให้
      // กฎ "ต้องมีใบจองหรือลิงก์อย่างน้อยหนึ่ง" หลุดได้ด้วยการลบลิงก์ทิ้งเฉย ๆ
      const merged = validateMixJob({
        title: 'title' in body ? body.title : existing.title,
        bookingId: existing.bookingId,
        dueDate: 'dueDate' in body ? body.dueDate : existing.dueDate?.toISOString().slice(0, 10),
        sourceLink: 'sourceLink' in body ? body.sourceLink : existing.sourceLink,
        notes: 'notes' in body ? body.notes : existing.notes,
      // v1.256 — ตอนขอบังคับวันที่ (v1.244) · แก้แล้วล้างวันที่ทิ้งไม่ได้ · แถวเก่าที่ไม่มีวันที่ยังแก้ช่องอื่นได้
      }, { requireDueDate: 'dueDate' in body })
      if (!merged.ok) return NextResponse.json({ error: merged.error }, { status: 400 })
      data.title = merged.value.title
      data.dueDate = merged.value.dueDate ? new Date(`${merged.value.dueDate}T00:00:00Z`) : null
      data.sourceLink = merged.value.sourceLink
      data.notes = merged.value.notes
      changes.edited = Object.keys(body).filter(k => ['title', 'dueDate', 'sourceLink', 'notes'].includes(k))
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'ไม่มีอะไรให้แก้' }, { status: 400 })
    }
    // v1.257 — งานเปลี่ยนสถานะ/เปลี่ยนคนทำ = คำขอเลื่อนที่ค้างอยู่ไม่มีความหมายแล้ว (ไม่งั้นเปิดงานกลับมาแล้วคำขอเก่าโผล่)
    // แก้กำหนดส่งตรง ๆ ก็เหมือนกัน: คำขอที่ค้างตั้งอยู่บนกำหนดเดิม (ผู้ตรวจ v1.257)
    if (('status' in data || assignedTo || (editing && 'dueDate' in body)) && !postpone) Object.assign(data, NO_POSTPONE)

    // v1.249 — ประวัติการเปลี่ยนครั้งนี้ (สถานะก่อน/หลัง) เขียนใน update เดียวกัน: งานเปลี่ยนแต่ประวัติหาย
    // เกิดไม่ได้ · ตัวเลขผลงาน/ภาระรายคนคิดจากที่นี่ (mix-stats.ts)
    const before = mixStateOf(existing)
    const after = mixStateOf({
      status: 'status' in data ? (data.status as string) : existing.status,
      assigneeEmail: 'assigneeEmail' in data ? (data.assigneeEmail as string | null) : existing.assigneeEmail,
      dueDate: 'dueDate' in data ? (data.dueDate as Date | null) : existing.dueDate,
    })
    data.events = { create: mixEventData(before, after, session.email, { claimed: body.claim === true }) }

    let job
    try {
      // ตัดสินคำขอเลื่อน: คำขอต้องยังเป็นตัวที่อ่านมา ณ ตอนเขียน ไม่งั้นคำขอใหม่ที่เพิ่งเข้ามาถูกล้างทิ้งเงียบ ๆ
      const where = decided ? { ...sameWorkState(existing), postponeToDate: existing.postponeToDate } : sameWorkState(existing)
      job = await prisma.mixJob.update({ where, data })
    } catch (e) {
      if (isNotFound(e)) return NextResponse.json({ error: CONFLICT }, { status: 409 })
      throw e
    }

    // แจ้งคนที่ถูกแจก + คนขอ · ไม่ throw ไม่ว่ากรณีใด งานที่แจกไปแล้วต้องไม่ถูก
    // ย้อนกลับเพราะเมลไม่ออก
    let notified: Awaited<ReturnType<typeof notifyMixAssigned>> | null = null
    if (assignedTo) {
      notified = await notifyMixAssigned(job, assignedTo, session.email)
      if (!notified.sent) console.warn(`[mix] แจ้งคนที่ถูกแจกไม่ออก: ${notified.reason}`)
    }
    // v1.217 — ขาที่หายไปตั้งแต่ v1.215: คนขอไม่เคยรู้ว่างานเสร็จ · เมลฉบับนี้มี
    // ลิงก์ไฟล์อยู่ในตัว จึงเป็นจุดที่วงจรปิดจริง
    if (data.status === 'DONE' && job.deliveryLink) {
      notified = await notifyMixDelivered(job, job.deliveryLink, session.email)
      if (!notified.sent) console.warn(`[mix] แจ้งส่งงานไม่ออก: ${notified.reason}`)
    }
    // v1.257 — ขอเลื่อน → คนขอ + Producer ของใบ · ตัดสินแล้ว → คนที่ขอเลื่อน
    if (postpone) {
      notified = await notifyMixPostponeRequested(
        job, [job.requesterEmail, existing.bookingProducerEmail], session.email, postpone.toDate, postpone.reason)
      if (!notified.sent) console.warn(`[mix] แจ้งขอเลื่อนไม่ออก: ${notified.reason}`)
    }
    if (decided) {
      notified = await notifyMixPostponeDecided(job, decided.requestedBy, session.email, decided.approved, decided.toDate)
      if (!notified.sent) console.warn(`[mix] แจ้งผลขอเลื่อนไม่ออก: ${notified.reason}`)
    }
    // v1.245 — ปฏิทินมิกซ์แยก: ทุกการแก้ (แจก/ส่งงาน/วันที่/ยกเลิก) ตามไปที่ event เดียว
    const cal = await syncMixJobCalendar(job.id)
    const calFields = cal.action === 'off' ? {}
      : cal.ok ? { calendarEventId: cal.eventId, calendarSyncError: null } : { calendarSyncError: cal.error }

    logAudit({
      actorEmail: session.email,
      action: 'mix.update',
      entityType: 'MixJob',
      entityId: job.id,
      bookingCode: job.bookingCode,
      changes: {
        number: job.number, ...changes,
        ...(notified ? { notified: notified.sent, notifiedTo: notified.to, notifyError: notified.reason ?? null } : {}),
        ...mixCalendarAuditNote(cal),
      },
    })
    return NextResponse.json({ job: { ...job, ...calFields, code: formatMixNumber(job.number) }, notified })
  } catch (e) {
    console.error('PATCH /api/mix/[id] error:', e)
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ' }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSoundAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const existing = await load(params.id)
    if (!existing) return NextResponse.json({ error: 'ไม่พบงานนี้' }, { status: 404 })

    const actor: MixActor = {
      email: session.email,
      isSound: access.isSound,
      isCoordinator: access.isCoordinator,
      canEditAll: access.canEditAll,
    }
    // v1.250 — กฎลบแยกจากกฎแก้: คนถืองาน/Sound Admin ลบไม่ได้แล้ว (ใช้ "ยกเลิก" แทน)
    if (!canDeleteMixJob(actor, existing)) {
      return NextResponse.json({ error: 'ลบได้เฉพาะคนขอ (ตอนยังไม่มีคนรับ) หรือแอดมิน — งานที่ไม่ต้องทำแล้วให้กด "ยกเลิก"' }, { status: 403 })
    }

    // soft delete — ทั้งรีโปนี้ไม่มีการลบถาวร และเลขที่ออกไปแล้วต้องไม่ถูกใช้ซ้ำ
    const state = mixStateOf(existing)
    try {
      await prisma.mixJob.update({
        where: sameWorkState(existing),
        data: { deletedAt: new Date(), events: { create: mixEventData(state, state, session.email, { deleted: true }) } },
      })
    } catch (e) {
      if (isNotFound(e)) return NextResponse.json({ error: CONFLICT }, { status: 409 })
      throw e
    }
    // v1.245 — ลบคำขอ = เอา event ออกจากปฏิทินมิกซ์ด้วย ไม่งั้นปฏิทินโชว์งานที่ไม่มีแล้ว
    const cal = await syncMixJobCalendar(existing.id)
    logAudit({
      actorEmail: session.email,
      action: 'mix.delete',
      entityType: 'MixJob',
      entityId: existing.id,
      bookingCode: existing.bookingCode,
      changes: { number: existing.number, title: existing.title, ...mixCalendarAuditNote(cal) },
    })
    // แถวที่ลบแล้วไม่โผล่บนการ์ด → error ต้องตอบกลับตรงนี้ ไม่งั้นไม่มีใครเห็นว่า event ยังค้าง
    return NextResponse.json({ ok: true, ...(cal.action !== 'off' && !cal.ok ? { calendarError: cal.error } : {}) })
  } catch (e) {
    console.error('DELETE /api/mix/[id] error:', e)
    return NextResponse.json({ error: 'ลบไม่สำเร็จ' }, { status: 500 })
  }
}
