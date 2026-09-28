/**
 * v1.244 — GET /api/mix/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — ภาระงานมิกซ์รายวัน
 *
 * สองคนใช้คนละคำถาม: คนขอดูว่า "ช่วงไหนคิวเบา" ก่อนเลือกวันที่ต้องการไฟล์ · Sound Admin
 * ดูว่า "ใครแน่นวันไหน" ก่อนแจกงาน — ตอบจากชุดเดียวกัน (buildMixCalendar ใน mix-jobs.ts)
 *
 * ทุกคนที่ล็อกอินดูได้ เหตุผลเดียวกับคิว: คนขอต้องเห็นว่าคิวยาวแค่ไหนก่อนรับปากลูกค้า
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import {
  buildMixCalendar, bangkokDateKey, addDaysKey, isValidISODate, formatMixNumber,
  MIX_CALENDAR_MAX_DAYS,
} from '@/lib/mix-jobs'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sp = new URL(request.url).searchParams
    const today = bangkokDateKey()
    const from = isValidISODate(sp.get('from')) ? sp.get('from')! : today
    let to = isValidISODate(sp.get('to')) ? sp.get('to')! : addDaysKey(from, 41)
    if (to < from) return NextResponse.json({ error: 'ช่วงวันที่กลับหัว' }, { status: 400 })
    const cap = addDaysKey(from, MIX_CALENDAR_MAX_DAYS - 1)
    if (to > cap) to = cap

    const [jobs, roster] = await Promise.all([
      prisma.mixJob.findMany({
        where: {
          deletedAt: null,
          status: { not: 'CANCELLED' },
          dueDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        select: {
          id: true, number: true, title: true, status: true, dueDate: true,
          assigneeEmail: true, bookingCode: true, episodeCode: true,
        },
        orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      }),
      prisma.teamMember.findMany({ where: { role: 'sound', active: true }, select: { email: true, name: true } }),
    ])

    return NextResponse.json({
      from, to, today,
      engineers: roster.length,
      soundTeam: roster,
      days: buildMixCalendar(jobs, from, to, roster.length),
      jobs: jobs.map(j => ({
        id: j.id,
        code: formatMixNumber(j.number),
        title: j.title,
        status: j.status,
        dueDate: j.dueDate ? j.dueDate.toISOString().slice(0, 10) : null,
        assigneeEmail: j.assigneeEmail,
        bookingCode: j.bookingCode,
        episodeCode: j.episodeCode,
      })),
    })
  } catch (e) {
    console.error('GET /api/mix/calendar error:', e)
    return NextResponse.json({ error: 'โหลดปฏิทินไม่สำเร็จ' }, { status: 500 })
  }
}
