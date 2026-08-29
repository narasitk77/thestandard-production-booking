/**
 * v1.211 — GET /api/switcher/export?month=YYYY-MM — บันทึกงานไลฟ์เป็น CSV
 *
 * เหตุผลที่มี: ปลายทางของข้อมูลชุดนี้คือรายงาน "ใครกินเวลาสวิตเชอร์เท่าไหร่"
 * ซึ่งวันนี้ทำในชีท ถ้าเอาออกไม่ได้ ก็เท่ากับย้ายจากไลน์มาติดอยู่ในเว็บแทน
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getSwitcherAccess } from '@/lib/session'
import { buildCSVHeader, rowToCSV } from '@/lib/csv'
import { todayBangkokStr } from '@/lib/bangkok-day'
import { getOutlet } from '@/lib/data'
import {
  PLATFORM_LABEL,
  formatDuration,
  jobDurationMinutes,
  readLinks,
  utcDateToISO,
} from '@/lib/switcher-jobs'

export const dynamic = 'force-dynamic'

const COLUMNS = [
  'Production ID', 'สังกัด', 'ชื่อหมาย', 'วันที่', 'เริ่ม', 'สิ้นสุด', 'ข้ามคืน',
  'ชั่วโมง', 'ชั่วโมง (ทศนิยม)', 'สวิตเชอร์', 'ผู้สั่งงาน', 'ลิงก์', 'หมายเหตุ', 'สถานะ', 'ที่มา',
]

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = await getSwitcherAccess(session.email, session.role)
  if (!access.canOpen) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const month = new URL(request.url).searchParams.get('month') || todayBangkokStr().slice(0, 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ error: 'month ต้องเป็น YYYY-MM' }, { status: 400 })
  }
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)

  const jobs = await prisma.switcherJob.findMany({
    where: { deletedAt: null, workDate: { gte: start, lt: end } },
    orderBy: [{ workDate: 'asc' }, { startTime: 'asc' }],
  })

  const lines = [buildCSVHeader(COLUMNS)]
  for (const j of jobs) {
    const mins = jobDurationMinutes(j)
    lines.push(rowToCSV([
      j.productionId || '',
      getOutlet(j.outletCode)?.name || j.outletCode,
      j.jobName,
      utcDateToISO(j.workDate),
      j.startTime || '',
      j.endTime || '',
      j.endDayOffset === 1 ? 'ใช่' : '',
      formatDuration(mins),
      mins === null ? '' : Math.round((mins / 60) * 100) / 100,
      j.switcherEmail || '',
      j.requestedBy || '',
      readLinks(j.links).map(l => `${PLATFORM_LABEL[l.platform]}: ${l.url}`).join(' | '),
      j.notes || '',
      j.status,
      j.source,
    ]) + '\n')
  }

  return new NextResponse(lines.join(''), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="switcher-${month}.csv"`,
    },
  })
}
