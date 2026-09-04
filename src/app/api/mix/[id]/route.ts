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
import {
  canEditMixJob, canClaimMixJob, canAssignMixJob, canSetMixStatus, isMixStatus,
  isAssignableTo, validateMixJob, formatMixNumber, type MixActor, type MixStatus,
} from '@/lib/mix-jobs'
import { notifyMixAssigned } from '@/lib/mix-notify'

export const dynamic = 'force-dynamic'

async function load(id: string) {
  return prisma.mixJob.findFirst({ where: { id, deletedAt: null } })
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
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

    // ── เปลี่ยนสถานะ ────────────────────────────────────────────────────────
    if (typeof body.status === 'string' && body.status !== existing.status) {
      if (!isMixStatus(body.status)) return NextResponse.json({ error: 'สถานะไม่ถูกต้อง' }, { status: 400 })
      const next = body.status as MixStatus
      if (!canSetMixStatus(actor, existing, next)) {
        return NextResponse.json({ error: 'เปลี่ยนสถานะนี้ไม่ได้' }, { status: 403 })
      }
      data.status = next
      // deliveredAt ผูกกับ DONE เสมอ — ตั้งเองแยกไม่ได้ ไม่งั้นวันที่ส่งกับสถานะ
      // จะเล่าคนละเรื่อง ซึ่งทำให้ตัวเลข "ส่งทันไหม" เชื่อไม่ได้
      data.deliveredAt = next === 'DONE' ? (existing.deliveredAt ?? new Date()) : null
      changes.status = { from: existing.status, to: next }
    }

    // ── แก้รายละเอียด ───────────────────────────────────────────────────────
    const editing = ['title', 'dueDate', 'sourceLink', 'notes'].some(k => k in body)
    if (editing) {
      if (!canEditMixJob(actor, existing)) {
        return NextResponse.json(
          { error: 'แก้ได้เฉพาะคำขอของตัวเองที่ยังไม่มีคนรับ หรืองานที่ตัวเองรับไว้' },
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
      })
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

    const job = await prisma.mixJob.update({ where: { id: existing.id }, data })

    // แจ้งคนที่ถูกแจก + คนขอ · ไม่ throw ไม่ว่ากรณีใด งานที่แจกไปแล้วต้องไม่ถูก
    // ย้อนกลับเพราะเมลไม่ออก
    let notified: Awaited<ReturnType<typeof notifyMixAssigned>> | null = null
    if (assignedTo) {
      notified = await notifyMixAssigned(job, assignedTo, session.email)
      if (!notified.sent) console.warn(`[mix] แจ้งคนที่ถูกแจกไม่ออก: ${notified.reason}`)
    }

    logAudit({
      actorEmail: session.email,
      action: 'mix.update',
      entityType: 'MixJob',
      entityId: job.id,
      bookingCode: job.bookingCode,
      changes: {
        number: job.number, ...changes,
        ...(notified ? { notified: notified.sent, notifiedTo: notified.to, notifyError: notified.reason ?? null } : {}),
      },
    })
    return NextResponse.json({ job: { ...job, code: formatMixNumber(job.number) }, notified })
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
    if (!canEditMixJob(actor, existing)) {
      return NextResponse.json({ error: 'ลบได้เฉพาะคำขอของตัวเองที่ยังไม่มีคนรับ' }, { status: 403 })
    }

    // soft delete — ทั้งรีโปนี้ไม่มีการลบถาวร และเลขที่ออกไปแล้วต้องไม่ถูกใช้ซ้ำ
    await prisma.mixJob.update({ where: { id: existing.id }, data: { deletedAt: new Date() } })
    logAudit({
      actorEmail: session.email,
      action: 'mix.delete',
      entityType: 'MixJob',
      entityId: existing.id,
      bookingCode: existing.bookingCode,
      changes: { number: existing.number, title: existing.title },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/mix/[id] error:', e)
    return NextResponse.json({ error: 'ลบไม่สำเร็จ' }, { status: 500 })
  }
}
