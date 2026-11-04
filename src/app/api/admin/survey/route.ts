import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { SURVEY_KEY, TEAM_MIN, summarize } from '@/lib/survey'
import { eligibleCount, isSurveyOpen, setSurveyOpen } from '@/lib/survey-db'

export const dynamic = 'force-dynamic'

/**
 * /api/admin/survey — ผลแบบสำรวจ (แอดมินเท่านั้น) + ปุ่มเปิด/ปิดรับคำตอบ
 * - ผลรวมโชว์เฉพาะตอน "ปิดรับ" แล้ว: ระหว่างเปิด รีเฟรชก่อน/หลังคนหนึ่งตอบ = เห็นคำตอบทั้งชุดของเขา
 *   (ด่านเบา ๆ — แอดมินปิดดูแล้วเปิดใหม่ได้ แต่ต้องตั้งใจทำ) ระหว่างเปิดคืนแค่จำนวนคนตอบ
 * - ปิดรับแล้วแต่มีคนตอบไม่ถึง TEAM_MIN = ยังไม่โชว์ผล (1–2 คน = ผลรวมคือคำตอบรายคน)
 * - แยกทีมเฉพาะทีมที่มีคนตอบ ≥ TEAM_MIN · ที่เหลือรวมเป็นก้อนเดียวโดยไม่บอกว่ามีทีมไหน (กลุ่มเล็กจนรู้ตัวได้)
 * - ข้อความเรียงตามตัวอักษร (ไม่เหลือข้อมูลลำดับคนตอบ) และไม่แยกตามทีม
 */
export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'เฉพาะแอดมิน' }, { status: 403 })
  try {
    const [open, participants, eligible] = await Promise.all([
      isSurveyOpen(SURVEY_KEY),
      prisma.surveyParticipant.count({ where: { surveyKey: SURVEY_KEY } }),
      eligibleCount(),
    ])
    if (open || participants < TEAM_MIN) return NextResponse.json({ key: SURVEY_KEY, open, participants, eligible, summary: null, teamMin: TEAM_MIN })

    const rows = await prisma.surveyResponse.findMany({ where: { surveyKey: SURVEY_KEY }, select: { group: true, answers: true } })
    const summary = summarize(rows, TEAM_MIN)
    for (const k of ['improve', 'other'] as const) summary.texts[k].sort((a, b) => a.localeCompare(b, 'th'))
    return NextResponse.json({ key: SURVEY_KEY, open, participants, eligible, summary, teamMin: TEAM_MIN })
  } catch (e: any) {
    console.error('[admin/survey] failed:', e?.message || e)
    return NextResponse.json({ error: `โหลดผลไม่ได้: ${e?.message || e}` }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'เฉพาะแอดมิน' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  if (typeof body.open !== 'boolean') return NextResponse.json({ error: 'ต้องส่ง open: true|false' }, { status: 400 })
  await setSurveyOpen(SURVEY_KEY, body.open)
  return NextResponse.json({ ok: true, open: body.open })
}
