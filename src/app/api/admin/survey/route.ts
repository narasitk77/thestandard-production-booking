import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { SURVEY_KEY, summarize } from '@/lib/survey'
import { eligibleCount, isSurveyOpen, setSurveyOpen } from '@/lib/survey-db'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 3_600_000

/**
 * /api/admin/survey — v1.278. ผลแบบสำรวจ (แอดมินเท่านั้น) + ปุ่มเปิด/ปิดรับคำตอบ
 * - ผลรวมโชว์เฉพาะตอน "ปิดรับ" แล้ว: ระหว่างเปิด รีเฟรชก่อน/หลังคนหนึ่งตอบ = เห็นคำตอบทั้งชุดของเขา
 *   (ด่านเบา ๆ — แอดมินปิดดูแล้วเปิดใหม่ได้ แต่ต้องตั้งใจทำ) ระหว่างเปิดคืนแค่จำนวนคนตอบ
 * - ทีมจัดคิวมีไม่กี่คน: 3 ข้อของกลุ่มนี้ซ่อนจนมีคนตอบอย่างน้อย QUEUE_MIN คน
 * - ข้อความเรียงตามตัวอักษร (ไม่เหลือข้อมูลลำดับคนตอบ)
 * volume = ฐานคูณ "นาทีที่ประหยัดต่อใบ" เป็นชั่วโมง/เดือน: ใบที่ไม่ใช่ routine ที่สร้างใน 30 วัน ·
 *   การอนุมัติใบที่ไม่ใช่ routine ใน 30 วัน (ไม่นับอนุมัติซ้ำจาก COMPLETED)
 */
const QUEUE_MIN = 3
export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'เฉพาะแอดมิน' }, { status: 403 })
  try {
    const since = new Date(Date.now() - 30 * DAY_MS)
    const [open, participants, eligible, booked, approvedRows] = await Promise.all([
      isSurveyOpen(SURVEY_KEY),
      prisma.surveyParticipant.count({ where: { surveyKey: SURVEY_KEY } }),
      eligibleCount(),
      prisma.booking.count({ where: { createdAt: { gte: since }, deletedAt: null, isRoutine: false } }),
      prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM audit_logs a JOIN bookings b ON b.id = a."entityId"
        WHERE a.action = 'booking.approve' AND a.at >= ${since} AND NOT b."isRoutine"
          AND coalesce(a."fromStatus", '') <> 'COMPLETED'`,
    ])
    const volume30d = { booked, approved: approvedRows[0]?.n ?? 0 }
    if (open) return NextResponse.json({ key: SURVEY_KEY, open, participants, eligible, volume30d, summary: null, queueMin: QUEUE_MIN })

    const rows = await prisma.surveyResponse.findMany({ where: { surveyKey: SURVEY_KEY }, select: { group: true, answers: true } })
    const summary = summarize(rows)
    for (const k of ['wish', 'note', 'other'] as const) summary.texts[k].sort((a, b) => a.localeCompare(b, 'th'))
    const queueHidden = summary.byGroup.queue > 0 && summary.byGroup.queue < QUEUE_MIN
    if (queueHidden) {
      for (const id of ['q_now', 'q_before', 'q_chase']) delete summary.counts[id]
      summary.perItem.queue = { before: null, now: null, saved: null, n: 0 }
    }
    return NextResponse.json({ key: SURVEY_KEY, open, participants, eligible, volume30d, summary, queueHidden, queueMin: QUEUE_MIN })
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
