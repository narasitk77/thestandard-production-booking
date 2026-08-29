/**
 * v1.211 — GET/POST /api/switcher — สมุดบันทึกงานไลฟ์ของสวิตเชอร์
 *
 * GET  ?month=YYYY-MM  รายการของเดือนนั้น + รายการที่ยังต้องตาม (ข้ามเดือน)
 * POST                 สวิตเชอร์บันทึกงานที่คุมไป → ระบบออก Production ID ให้
 *
 * ขอบเขตการมองเห็น (ตอบนัท 2026-08-29): สวิตเชอร์เห็นของทุกคน แต่แก้ได้เฉพาะ
 * ของตัวเอง — พวกเขาอยู่กลุ่มไลน์เดียวกันและต้องเห็นว่าหมายไหนมีคนลงไปแล้ว
 * ไม่งั้นจะลงซ้ำกันเอง
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getSession, getSwitcherAccess } from '@/lib/session'
import { getOutlet } from '@/lib/data'
import { logAudit } from '@/lib/audit'
import { todayBangkokStr } from '@/lib/bangkok-day'
import {
  isoDateToUTC,
  followUpReason,
  validateSwitcherPayload,
} from '@/lib/switcher-jobs'
import { lockSwitcherSequence, mintSwitcherProductionId } from '@/lib/switcher-mint'

export const dynamic = 'force-dynamic'

/** ย้อนหลังกี่วันที่ยังถือว่า "ตามได้" — เก่ากว่านี้ตามไปก็ไม่มีใครจำแล้ว */
const FOLLOW_UP_LOOKBACK_DAYS = 60
const FOLLOW_UP_LIMIT = 50

function monthRange(month: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null
  const start = new Date(`${month}-01T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { start, end }
}

function daysAgoUTC(days: number): Date {
  const [y, m, d] = todayBangkokStr().split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt
}

const ORDER = [{ workDate: 'desc' as const }, { startTime: 'desc' as const }, { createdAt: 'desc' as const }]

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSwitcherAccess(session.email, session.role)
    if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const month = new URL(request.url).searchParams.get('month') || todayBangkokStr().slice(0, 7)
    const range = monthRange(month)
    if (!range) return NextResponse.json({ error: 'month ต้องเป็น YYYY-MM' }, { status: 400 })

    // รายการที่ยังต้องตาม **ไม่ผูกกับเดือนที่เลือก** โดยตั้งใจ: ของค้างเดือนก่อน
    // คือของที่ต้องตามที่สุด ถ้าซ่อนตามตัวกรองเดือนก็เท่ากับไม่มีใครเห็นมันอีกเลย
    const [jobs, recent] = await Promise.all([
      prisma.switcherJob.findMany({
        where: { deletedAt: null, workDate: { gte: range.start, lt: range.end } },
        orderBy: ORDER,
      }),
      prisma.switcherJob.findMany({
        where: { deletedAt: null, workDate: { gte: daysAgoUTC(FOLLOW_UP_LOOKBACK_DAYS) } },
        orderBy: ORDER,
        take: 500,
      }),
    ])

    const followUps = recent
      .filter(j => followUpReason(j) !== null)
      .slice(0, FOLLOW_UP_LIMIT)

    return NextResponse.json({
      jobs,
      followUps,
      followUpTruncated: recent.filter(j => followUpReason(j) !== null).length > FOLLOW_UP_LIMIT,
      month,
      me: {
        email: session.email,
        isSwitcher: access.isSwitcher,
        canEditAll: access.canEditAll,
        canCreate: access.isSwitcher || access.canEditAll,
      },
    })
  } catch (e) {
    console.error('GET /api/switcher error:', e)
    return NextResponse.json({ error: 'โหลดข้อมูลไม่สำเร็จ' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const access = await getSwitcherAccess(session.email, session.role)
    // คนที่ "ดูได้" (coordinator) ไม่ได้แปลว่า "ลงงานแทนคนอื่นได้" — การบันทึกงาน
    // เป็นของสวิตเชอร์เจ้าของงาน ส่วน admin/manager ลงให้ได้ไว้ซ่อมข้อมูล
    if (!access.isSwitcher && !access.canEditAll) {
      return NextResponse.json({ error: 'เฉพาะทีมสวิตเชอร์เท่านั้นที่บันทึกงานได้' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = validateSwitcherPayload(body, c => !!getOutlet(c))
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { outletCode, jobName, workDate, startTime, endTime, endDayOffset, links, requestedBy, notes } = parsed

    const job = await prisma.$transaction(async (tx) => {
      await lockSwitcherSequence(tx, outletCode, workDate)
      const productionId = await mintSwitcherProductionId(tx, outletCode, workDate)
      return tx.switcherJob.create({
        data: {
          productionId,
          outletCode,
          jobName,
          workDate: isoDateToUTC(workDate),
          startTime,
          endTime,
          endDayOffset,
          // Prisma พิมพ์ Json column เป็น InputJsonValue ซึ่งไม่รับ array ของ
          // interface ตรง ๆ — ค่าถูก normalize มาแล้วโดย validateSwitcherPayload
          links: links as unknown as Prisma.InputJsonValue,
          requestedBy,
          notes,
          switcherEmail: session.email,
          source: 'MANUAL',
          status: 'LOGGED',
          createdByEmail: session.email,
        },
      })
    })

    logAudit({
      actorEmail: session.email,
      action: 'SWITCHER_JOB_CREATE',
      entityType: 'SwitcherJob',
      entityId: job.id,
      bookingCode: job.productionId,
      changes: { jobName, workDate, startTime, endTime, links },
    })

    return NextResponse.json({ job }, { status: 201 })
  } catch (e) {
    console.error('POST /api/switcher error:', e)
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ' }, { status: 500 })
  }
}
