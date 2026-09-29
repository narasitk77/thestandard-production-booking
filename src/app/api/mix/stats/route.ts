/**
 * v1.249 — GET /api/mix/stats?from=YYYY-MM-DD&to=YYYY-MM-DD — ภาระ/ผลงานทีมเสียงรายคน (dashboard)
 *
 * เฉพาะ Sound Admin + แอดมิน/ผู้จัดการ (ผลงานรายคนไม่เปิดทุกคน · ปฏิทินภาระรวมเปิดทุกคนที่ /api/mix/calendar)
 * ไม่ส่งช่วง = เดือนนี้ · คิดจาก mix-stats.ts ชุดเดียวกับ export CSV
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { buildMixStats, mixStatsRange, bangkokDateTime } from '@/lib/mix-stats'
import { bangkokDateKey } from '@/lib/mix-jobs'
import { loadMixStatsInput, mixStatsAccess } from '@/lib/mix-stats-data'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await mixStatsAccess(session.email, session.role))) {
      return NextResponse.json({ error: 'ดูตัวเลขผลงานรายคนได้เฉพาะ Sound Admin และแอดมิน' }, { status: 403 })
    }
    const sp = new URL(request.url).searchParams
    const today = bangkokDateKey()
    const range = mixStatsRange(sp.get('from'), sp.get('to'), today)
    if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 })

    const { jobs, roster } = await loadMixStatsInput()
    const s = buildMixStats(jobs, roster, range, today)
    return NextResponse.json({
      range: s.range,
      today: s.today,
      generatedAt: bangkokDateTime(new Date()),
      team: s.team,
      people: s.people,
      // มีงานที่ตัวเลขช่วงต้นมาจากแถวงาน (ก่อนเริ่มเก็บประวัติ v1.249) — หน้าจอบอกคนดูตรง ๆ
      legacyJobs: s.histories.filter(h => h.timeline.some(e => e.synthetic)).length,
    })
  } catch (e) {
    console.error('GET /api/mix/stats error:', e)
    return NextResponse.json({ error: 'คำนวณตัวเลขไม่สำเร็จ' }, { status: 500 })
  }
}
