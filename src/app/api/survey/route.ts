import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { SURVEY_KEY, validateAnswers } from '@/lib/survey'
import { hasAnswered, isSurveyEligible, isSurveyOpen, saveSurveyAnswer } from '@/lib/survey-db'
import { hasConsoleAccess } from '@/lib/roles'

export const dynamic = 'force-dynamic'

/**
 * /api/survey — แบบสำรวจการใช้งาน (v1.278 · v1.279 เปลี่ยนชุดคำถาม — นิยามอยู่ที่ src/lib/survey.ts)
 * GET  → สถานะของคนที่ล็อกอิน: เปิดรับไหม / มีสิทธิ์ไหม / ตอบแล้วหรือยัง (ไม่คืนคำตอบใด ๆ)
 *        canPreview = ทีมจัดคิว (ไม่มีสิทธิ์ตอบแล้วตั้งแต่ v1.279) ยังเปิดดูหน้าแบบสำรวจได้ แต่ส่งไม่ได้
 * POST → ส่งคำตอบ: ต้องเปิดรับ + มีสิทธิ์ + ยังไม่เคยตอบ · ไม่เขียน audit (audit มีอีเมล+เวลา = จับคู่คำตอบได้)
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const [open, eligible, answered] = await Promise.all([
      isSurveyOpen(SURVEY_KEY), isSurveyEligible(session.email, session.role), hasAnswered(SURVEY_KEY, session.email),
    ])
    return NextResponse.json({ key: SURVEY_KEY, open, eligible, answered, canPreview: hasConsoleAccess(session.role) })
  } catch (e: any) {
    console.error('[survey] status failed:', e?.message || e)
    return NextResponse.json({ error: 'โหลดสถานะแบบสำรวจไม่ได้ ลองใหม่อีกครั้งนะครับ' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || body.key !== SURVEY_KEY) return NextResponse.json({ error: 'แบบสำรวจนี้ปิดไปแล้ว — ลองรีเฟรชหน้าดูนะครับ' }, { status: 409 })
  const v = validateAnswers(body.answers)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    if (!(await isSurveyOpen(SURVEY_KEY))) return NextResponse.json({ error: 'ตอนนี้ยังไม่เปิดรับคำตอบครับ' }, { status: 409 })
    if (!(await isSurveyEligible(session.email, session.role))) {
      return NextResponse.json({ error: 'แบบสำรวจรอบนี้ถามเฉพาะคนที่จองคิวถ่ายครับ' }, { status: 403 })
    }
    const r = await saveSurveyAnswer(SURVEY_KEY, session.email, v.group, v.answers)
    // answered:true ให้หน้าเปลี่ยนเป็น "ตอบไปแล้ว" (เช่นรอบแรกบันทึกแล้วแต่เน็ตหลุดก่อนได้คำตอบ) — ไม่ใช่ 200:
    // ถ้าเป็นแท็บที่สองที่ตอบไม่เหมือนกัน ชุดนี้ไม่ได้ถูกบันทึกจริง
    if (r === 'duplicate') return NextResponse.json({ error: 'คุณตอบแบบสำรวจนี้ไปแล้ว ขอบคุณมากครับ 🙏', answered: true }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[survey] save failed:', e?.message || e)
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ คำตอบยังไม่ถูกเก็บ — ลองกดส่งอีกครั้งนะครับ' }, { status: 500 })
  }
}
