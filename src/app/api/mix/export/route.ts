/**
 * v1.249 — GET /api/mix/export?type=jobs|people|events&from=YYYY-MM-DD&to=YYYY-MM-DD — CSV งานมิกซ์
 *
 *  - jobs   = หนึ่งแถวต่องานที่ "มีชีวิต" ในช่วง (ขอก่อนสิ้นช่วง ยังไม่จบก่อนต้นช่วง) พร้อมเวลารอแจก/เวลาทำ/ทันกำหนด
 *  - people = สรุปรายคน ตัวเลขเดียวกับ dashboard (/api/mix/stats)
 *  - events = ประวัติทุกการเปลี่ยนในช่วง (ขอ/แจก/ส่ง/เปิดแก้/ยกเลิก/เลื่อนวัน/ลบ)
 *
 * สิทธิ์เดียวกับ dashboard · ทุกการ export ลง audit (ข้อมูลผลงานรายคนออกนอกระบบ ต้องรู้ว่าใครเอาไป)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { buildCSVHeader, rowToCSV, csvFilename } from '@/lib/csv'
import { bangkokDateKey } from '@/lib/mix-jobs'
import {
  buildMixStats, mixStatsRange, mixActiveInRange, mixJobCsvRow, mixPersonCsvRow, mixEventsCsvRowsSorted,
  MIX_JOBS_CSV_COLUMNS, MIX_PEOPLE_CSV_COLUMNS, MIX_EVENTS_CSV_COLUMNS,
} from '@/lib/mix-stats'
import { loadMixStatsInput, mixStatsAccess } from '@/lib/mix-stats-data'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const TYPES = ['jobs', 'people', 'events'] as const
type ExportType = (typeof TYPES)[number]

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await mixStatsAccess(session.email, session.role))) {
      return NextResponse.json({ error: 'export ได้เฉพาะ Sound Admin และแอดมิน' }, { status: 403 })
    }
    const sp = new URL(request.url).searchParams
    const type = sp.get('type') as ExportType
    if (!TYPES.includes(type)) return NextResponse.json({ error: 'type ต้องเป็น jobs, people หรือ events' }, { status: 400 })
    const range = mixStatsRange(sp.get('from'), sp.get('to'), bangkokDateKey())
    if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 })

    const { jobs, roster } = await loadMixStatsInput()
    const s = buildMixStats(jobs, roster, range)

    let columns: string[]
    let rows: unknown[][]
    if (type === 'people') {
      columns = MIX_PEOPLE_CSV_COLUMNS
      rows = s.people.map(mixPersonCsvRow)
    } else if (type === 'events') {
      columns = MIX_EVENTS_CSV_COLUMNS
      rows = mixEventsCsvRowsSorted(s.histories, range)
    } else {
      columns = MIX_JOBS_CSV_COLUMNS
      rows = s.histories.filter(h => mixActiveInRange(h, range)).map(mixJobCsvRow)
    }

    logAudit({
      actorEmail: session.email,
      action: 'mix.export',
      entityType: 'MixJob',
      entityId: 'bulk',
      changes: { type, from: range.from, to: range.to, rows: rows.length },
    })
    const body = buildCSVHeader(columns) + rows.map(r => rowToCSV(r) + '\n').join('')
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(`mix-${type}`, range.from, range.to)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('GET /api/mix/export error:', e)
    return NextResponse.json({ error: 'export ไม่สำเร็จ' }, { status: 500 })
  }
}
