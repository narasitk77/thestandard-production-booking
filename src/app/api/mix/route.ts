/**
 * v1.215 — GET/POST /api/mix — คิวงานมิกซ์เสียง
 *
 * GET  ?scope=open|mine|all   คิวปัจจุบัน (ค่าเริ่มต้น open = ยังไม่จบ)
 *      ?scope=producer        v1.256 เมนู Producer: ที่ฉันขอ + ที่ผูกกับใบจองที่ฉันเป็น Producer (ทุกสถานะ)
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
  episodeBelongsToBooking, findDuplicateMixJobs,
} from '@/lib/mix-jobs'
import { notifyMixRequested } from '@/lib/mix-notify'
import { syncMixJobCalendar, mixCalendarAuditNote, mixCalendarId } from '@/lib/mix-calendar'
import { mixEventData } from '@/lib/mix-stats'
import { attachBookingProducer, producerBookingIds } from '@/lib/mix-targets'

export const dynamic = 'force-dynamic'

const LIST_LIMIT = 300

/** ผลซิงก์ปฏิทินที่ต้องสะท้อนกลับในแถวที่ตอบ (แถวที่ create คืนมายังไม่มีค่าจากการซิงก์) */
function calendarFields(cal: Awaited<ReturnType<typeof syncMixJobCalendar>>) {
  if (cal.action === 'off') return {}
  return cal.ok ? { calendarEventId: cal.eventId, calendarSyncError: null } : { calendarSyncError: cal.error }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSoundAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const sp = new URL(request.url).searchParams
    const scope = sp.get('scope') || 'open'
    // v1.219 — ดูคำขอของใบจองใบเดียว (การ์ดบนหน้าใบจองใช้ตัวนี้)
    // แยกจาก scope โดยตั้งใจ: ถามว่า "ใบนี้มีคำขออะไรบ้าง" ไม่ใช่ "คิวตอนนี้เป็นไง"
    // และต้องเห็นทุกสถานะ รวมที่จบแล้ว ไม่งั้นคนจะขอซ้ำเพราะไม่เห็นของเดิม
    const bookingId = sp.get('bookingId')?.trim() || null

    // ทั้งคิวมองเห็นได้หมดโดยตั้งใจ — คนขอต้องเห็นว่าคิวยาวแค่ไหนก่อนไปรับปาก
    // ลูกค้าว่าจะได้วันไหน · และกฎ "เห็นเฉพาะของตัวเอง" คือคลาสบั๊กที่ทำให้
    // โปรดิวเซอร์ 59 คนมองไม่เห็นงานตัวเองใน v1.196 — เลี่ยงทั้งคลาสไปเลย
    const where = bookingId
      ? { deletedAt: null, bookingId }
      : scope === 'mine'
        ? { deletedAt: null, OR: [{ requesterEmail: session.email }, { assigneeEmail: session.email }] }
        // v1.256 — นับใบที่ฉันเป็น Producer ด้วย ไม่ใช่แค่ที่ฉันกดขอ (บทเรียน v1.196: ผู้ช่วยกดแทนแล้ว Producer มองไม่เห็น)
        : scope === 'producer'
          ? { deletedAt: null, OR: [{ requesterEmail: session.email }, { bookingId: { in: await producerBookingIds(session.email) } }] }
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

    const calendarOn = !!mixCalendarId()
    // v1.256 — Producer ของใบไปกับทุกแถว ให้ปุ่ม "แก้ไข" บนการ์ดตัดสินด้วยข้อมูลเดียวกับ PATCH
    const jobs = (await attachBookingProducer(rows))
      .sort(compareMixQueue)
      // ปิดปฏิทินมิกซ์แล้ว (ล้าง MIX_CALENDAR_ID) = error เก่าไม่มีความหมาย ไม่ให้ค้างบนการ์ดตลอดไป
      .map((j) => ({ ...j, calendarSyncError: calendarOn ? j.calendarSyncError : null, code: formatMixNumber(j.number), flag: mixFlag(j) }))

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
    const clean = validateMixJob(body, { requireDueDate: true })
    if (!clean.ok) return NextResponse.json({ error: clean.error }, { status: 400 })

    // ผูกใบจอง = ต้องมีใบจองนั้นจริง · เก็บ bookingCode เป็น snapshot ไว้ให้รายงาน
    // ยังอ่านออกหลังใบจองถูกเปลี่ยนชื่อหรือย้ายสังกัด (v1.163 ย้ายสังกัดเขียน
    // bookingCode ใหม่) — เก็บแค่ id อย่างเดียวแล้ววันหนึ่งใบจองหาย รายงานจะกลาย
    // เป็นแถวที่ไม่มีใครรู้ว่าคืองานอะไร
    let bookingCode: string | null = null
    let episodeCode: string | null = null
    if (clean.value.bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: clean.value.bookingId, deletedAt: null },
        select: { id: true, bookingCode: true, status: true },
      })
      if (!booking) return NextResponse.json({ error: 'ไม่พบใบจองที่ผูกมา' }, { status: 400 })
      if (booking.status === 'CANCELLED') {
        return NextResponse.json({ error: `ใบจอง ${booking.bookingCode || ''} ถูกยกเลิกแล้ว — ถ้ายังต้องมิกซ์ ใส่ลิงก์ไฟล์เป็นงานเดี่ยวแทน` }, { status: 400 })
      }
      bookingCode = booking.bookingCode

      // v1.244 — ตอนที่เลือกต้องอยู่ในใบจองนี้จริง: ฟอร์มส่งสองค่าแยกกัน หน้าเว็บค้าง/ร่างเก่า
      // ทำให้ผูกใบ A กับตอนของใบ B ได้ แล้วทีมเสียงไปหยิบไฟล์ผิดกอง
      if (clean.value.episodeRowId) {
        const ep = await prisma.episode.findUnique({
          where: { id: clean.value.episodeRowId },
          select: { bookingId: true, episodeId: true },
        })
        if (!episodeBelongsToBooking(ep, booking.id)) {
          return NextResponse.json({ error: `ตอนที่เลือกไม่ได้อยู่ในใบจอง ${booking.bookingCode || ''} — ตรวจรหัสใหม่อีกครั้ง` }, { status: 400 })
        }
        episodeCode = ep!.episodeId
      }

      // v1.244 — ขอซ้ำ: ไม่ห้าม (งานเดียวกันอาจต้องสองเวอร์ชัน) แต่ต้องยืนยัน — คำขอซ้ำที่ไม่มีใคร
      // รู้คือทีมเสียงทำงานเดียวกันสองรอบ · 409 พร้อมรหัสที่ชน ให้ฟอร์มถามต่อได้
      if (body.confirmDuplicate !== true) {
        const open = await prisma.mixJob.findMany({
          where: { deletedAt: null, bookingId: booking.id, status: { in: [...OPEN_MIX_STATUSES] } },
          select: { number: true, bookingId: true, episodeRowId: true, status: true, deletedAt: true },
        })
        const dupes = findDuplicateMixJobs(open, { bookingId: booking.id, episodeRowId: clean.value.episodeRowId })
        if (dupes.length > 0) {
          return NextResponse.json({
            error: `มีคำขอที่ยังเปิดอยู่ของงานนี้แล้ว: ${dupes.map(d => formatMixNumber(d.number)).join(', ')}`,
            duplicates: dupes.map(d => formatMixNumber(d.number)),
          }, { status: 409 })
        }
      }
    }

    const job = await prisma.mixJob.create({
      data: {
        title: clean.value.title,
        bookingId: clean.value.bookingId,
        bookingCode,
        episodeRowId: clean.value.episodeRowId,
        episodeCode,
        dueDate: clean.value.dueDate ? new Date(`${clean.value.dueDate}T00:00:00Z`) : null,
        sourceLink: clean.value.sourceLink,
        notes: clean.value.notes,
        requesterEmail: session.email,
        createdByEmail: session.email,
        status: 'QUEUED',
        // v1.249 — ประวัติงานเริ่มที่นี่ ใน write เดียวกัน (ไม่ใช่ audit_logs ที่หายได้)
        events: { create: mixEventData(null, { status: 'QUEUED', assigneeEmail: null, dueDate: clean.value.dueDate }, session.email) },
      },
    })

    // แจ้งกล่องกลางทีมเสียง + coordinator · รอผลก่อนตอบกลับ เพื่อบอกคนขอได้ตรง ๆ
    // ว่าแจ้งถึงใครแล้วบ้าง — "ส่งคำขอแล้ว" ที่ไม่มีใครได้รับคือคำโกหกที่สุภาพ
    const notified = await notifyMixRequested(job)
    if (!notified.sent) console.warn(`[mix] แจ้งเตือนไม่ออก: ${notified.reason}`)
    // v1.245 — ปฏิทินมิกซ์แยก (ปิดอยู่ถ้าไม่ได้ตั้ง MIX_CALENDAR_ID) · รอผลเพื่อบันทึกความจริงลง audit
    const cal = await syncMixJobCalendar(job.id)

    logAudit({
      actorEmail: session.email,
      action: 'mix.request',
      entityType: 'MixJob',
      entityId: job.id,
      bookingCode,
      // บันทึกผลการแจ้งเตือนแบบราย recipient ไม่ยุบเป็น boolean (บทเรียน v1.186)
      changes: {
        number: job.number, title: job.title, dueDate: clean.value.dueDate,
        episodeCode, duplicateConfirmed: body.confirmDuplicate === true || undefined,
        notified: notified.sent, notifiedTo: notified.to, notifyError: notified.reason ?? null,
        ...mixCalendarAuditNote(cal),
      },
    })

    return NextResponse.json({
      job: { ...job, ...calendarFields(cal), code: formatMixNumber(job.number) },
      notified,
    }, { status: 201 })
  } catch (e) {
    console.error('POST /api/mix error:', e)
    return NextResponse.json({ error: 'ตั้งคำขอไม่สำเร็จ' }, { status: 500 })
  }
}
