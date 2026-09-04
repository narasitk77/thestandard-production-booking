/**
 * v1.215 — GET/POST /api/mix — คิวงานมิกซ์เสียง
 *
 * GET  ?scope=open|mine|all   คิวปัจจุบัน (ค่าเริ่มต้น open = ยังไม่จบ)
 * POST                        ตั้งคำขอมิกซ์ · **ใครที่ล็อกอินก็ขอได้**
 *
 * ทำไมใครก็ขอได้: คนขอมิกซ์คือโปรดิวเซอร์/คนตัด/ใครก็ตามที่มีงาน ถ้ากั้นด้วย role
 * ต้องมาไล่เพิ่มคนทีละคน แล้วคนที่เพิ่มไม่ทันก็กลับไปทักในไลน์เหมือนเดิม = คิวว่าง
 * เปล่าเหมือน switcher_jobs · ส่วนการ **รับงาน/เปลี่ยนสถานะ** ยังกั้นไว้ที่ทีมเสียง
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getSoundAccess } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  OPEN_MIX_STATUSES, validateMixJob, formatMixNumber, mixFlag, compareMixQueue,
} from '@/lib/mix-jobs'
import { notifyMixRequested } from '@/lib/mix-notify'

export const dynamic = 'force-dynamic'

const LIST_LIMIT = 300

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSoundAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const scope = new URL(request.url).searchParams.get('scope') || 'open'

    // ทั้งคิวมองเห็นได้หมดโดยตั้งใจ — คนขอต้องเห็นว่าคิวยาวแค่ไหนก่อนไปรับปาก
    // ลูกค้าว่าจะได้วันไหน · และกฎ "เห็นเฉพาะของตัวเอง" คือคลาสบั๊กที่ทำให้
    // โปรดิวเซอร์ 59 คนมองไม่เห็นงานตัวเองใน v1.196 — เลี่ยงทั้งคลาสไปเลย
    const where =
      scope === 'mine'
        ? { deletedAt: null, OR: [{ requesterEmail: session.email }, { assigneeEmail: session.email }] }
        : scope === 'all'
          ? { deletedAt: null }
          : { deletedAt: null, status: { in: [...OPEN_MIX_STATUSES] } }

    // roster ส่งไปกับคิวเลย เพื่อให้ coordinator มี dropdown เลือกคนได้โดยไม่ต้อง
    // ยิงอีกรอบ — และเพื่อให้หน้าเว็บใช้ "รายชื่อเดียวกับที่ route ใช้ตรวจ" ไม่งั้น
    // dropdown จะโชว์คนที่ฝั่งเซิร์ฟเวอร์ปฏิเสธ
    const [rows, roster] = await Promise.all([
      prisma.mixJob.findMany({ where, take: LIST_LIMIT, orderBy: { number: 'desc' } }),
      prisma.teamMember.findMany({
        where: { role: 'sound', active: true },
        select: { email: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ])

    const jobs = rows
      .sort(compareMixQueue)
      .map((j) => ({ ...j, code: formatMixNumber(j.number), flag: mixFlag(j) }))

    return NextResponse.json({
      jobs,
      scope,
      truncated: rows.length === LIST_LIMIT,
      soundTeam: roster,
      me: {
        email: session.email,
        isSound: access.isSound,
        isCoordinator: access.isCoordinator,
        canEditAll: access.canEditAll,
        // ทุกคนที่เปิดหน้าได้ตั้งคำขอได้ — ไม่มีเงื่อนไขซ่อน
        canCreate: true,
      },
    })
  } catch (e) {
    console.error('GET /api/mix error:', e)
    return NextResponse.json({ error: 'โหลดคิวไม่สำเร็จ' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSoundAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const clean = validateMixJob(body)
    if (!clean.ok) return NextResponse.json({ error: clean.error }, { status: 400 })

    // ผูกใบจอง = ต้องมีใบจองนั้นจริง · เก็บ bookingCode เป็น snapshot ไว้ให้รายงาน
    // ยังอ่านออกหลังใบจองถูกเปลี่ยนชื่อหรือย้ายสังกัด (v1.163 ย้ายสังกัดเขียน
    // bookingCode ใหม่) — เก็บแค่ id อย่างเดียวแล้ววันหนึ่งใบจองหาย รายงานจะกลาย
    // เป็นแถวที่ไม่มีใครรู้ว่าคืองานอะไร
    let bookingCode: string | null = null
    if (clean.value.bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: clean.value.bookingId, deletedAt: null },
        select: { id: true, bookingCode: true },
      })
      if (!booking) return NextResponse.json({ error: 'ไม่พบใบจองที่ผูกมา' }, { status: 400 })
      bookingCode = booking.bookingCode
    }

    const job = await prisma.mixJob.create({
      data: {
        title: clean.value.title,
        bookingId: clean.value.bookingId,
        bookingCode,
        dueDate: clean.value.dueDate ? new Date(`${clean.value.dueDate}T00:00:00Z`) : null,
        sourceLink: clean.value.sourceLink,
        notes: clean.value.notes,
        requesterEmail: session.email,
        createdByEmail: session.email,
        status: 'QUEUED',
      },
    })

    // แจ้งกล่องกลางทีมเสียง + coordinator · รอผลก่อนตอบกลับ เพื่อบอกคนขอได้ตรง ๆ
    // ว่าแจ้งถึงใครแล้วบ้าง — "ส่งคำขอแล้ว" ที่ไม่มีใครได้รับคือคำโกหกที่สุภาพ
    const notified = await notifyMixRequested(job)
    if (!notified.sent) console.warn(`[mix] แจ้งเตือนไม่ออก: ${notified.reason}`)

    logAudit({
      actorEmail: session.email,
      action: 'mix.request',
      entityType: 'MixJob',
      entityId: job.id,
      bookingCode,
      // บันทึกผลการแจ้งเตือนแบบราย recipient ไม่ยุบเป็น boolean (บทเรียน v1.186)
      changes: {
        number: job.number, title: job.title, dueDate: clean.value.dueDate,
        notified: notified.sent, notifiedTo: notified.to, notifyError: notified.reason ?? null,
      },
    })

    return NextResponse.json({
      job: { ...job, code: formatMixNumber(job.number) },
      notified,
    }, { status: 201 })
  } catch (e) {
    console.error('POST /api/mix error:', e)
    return NextResponse.json({ error: 'ตั้งคำขอไม่สำเร็จ' }, { status: 500 })
  }
}
