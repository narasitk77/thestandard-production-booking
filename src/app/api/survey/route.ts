import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { SURVEY_KEY, applyOverrides, validateAnswers } from '@/lib/survey'
import { getSurveyText, hasAnswered, isSurveyOpen, saveSurveyAnswer, surveySegment } from '@/lib/survey-db'
import { hasConsoleAccess } from '@/lib/roles'

export const dynamic = 'force-dynamic'

/**
 * /api/survey — แบบสำรวจการใช้งาน (v1.278 · v1.279 เปลี่ยนชุดคำถาม — นิยามอยู่ที่ src/lib/survey.ts)
 * GET  → สถานะของคนที่ล็อกอิน: เปิดรับไหม / ตอบแล้วหรือยัง (ไม่คืนคำตอบใด ๆ) + `survey` ชุดคำถามที่ใช้จริง (โค้ด + คำที่แอดมินแก้ v1.279.3)
 *        canPreview = ทีมจัดคิว/แอดมิน — ตอนปิดรับเปิดดูหน้าตัวอย่างได้ (ส่งไม่ได้) · ตอนเปิดรับตอบจริงได้เหมือนทุกคน (v1.285.1)
 * POST → ส่งคำตอบ: ต้องเปิดรับ + ยังไม่เคยตอบ (ทุกคนที่ล็อกอินตอบได้) · ใส่ `seg` = คนจองคิวไหม ลงไปกับคำตอบ · ไม่เขียน audit (audit มีอีเมล+เวลา = จับคู่คำตอบได้)
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const [open, answered, text] = await Promise.all([
      isSurveyOpen(SURVEY_KEY), hasAnswered(SURVEY_KEY, session.email), getSurveyText(SURVEY_KEY),
    ])
    return NextResponse.json({ key: SURVEY_KEY, open, answered, canPreview: hasConsoleAccess(session.role), survey: applyOverrides(text) })
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
  try {
    // ตรวจกับชุดคำถามที่ใช้จริง (required อาจถูกแอดมินเปลี่ยน) — ไม่ใช่ SURVEY ในโค้ดตรง ๆ
    const v = validateAnswers(body.answers, applyOverrides(await getSurveyText(SURVEY_KEY)))
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    if (!(await isSurveyOpen(SURVEY_KEY))) return NextResponse.json({ error: 'ตอนนี้ยังไม่เปิดรับคำตอบครับ' }, { status: 409 })
    // seg มาจากฝั่ง server เท่านั้น (validateAnswers ตัดคีย์แปลกทิ้งอยู่แล้ว ฝั่ง client ใส่เองไม่ได้)
    const r = await saveSurveyAnswer(SURVEY_KEY, session.email, v.group, { ...v.answers, seg: await surveySegment(session.email) })
    // answered:true ให้หน้าเปลี่ยนเป็น "ตอบไปแล้ว" (เช่นรอบแรกบันทึกแล้วแต่เน็ตหลุดก่อนได้คำตอบ) — ไม่ใช่ 200:
    // ถ้าเป็นแท็บที่สองที่ตอบไม่เหมือนกัน ชุดนี้ไม่ได้ถูกบันทึกจริง
    if (r === 'duplicate') return NextResponse.json({ error: 'คุณตอบแบบสำรวจนี้ไปแล้ว ขอบคุณมากครับ 🙏', answered: true }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[survey] save failed:', e?.message || e)
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ คำตอบยังไม่ถูกเก็บ — ลองกดส่งอีกครั้งนะครับ' }, { status: 500 })
  }
}
