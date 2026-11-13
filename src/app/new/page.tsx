import { redirect } from 'next/navigation'
import NewBookingClient from '@/app/_components/NewBookingClient'
import { getSession } from '@/lib/session'
import { SURVEY_KEY } from '@/lib/survey'
import { mustAnswerSurvey } from '@/lib/survey-db'

export const dynamic = 'force-dynamic'

// /new — single-booking wizard for everyone; console users also get a
// "Routine" mode toggle (see NewBookingClient).
// v1.287.1 — ตอนแบบสำรวจเปิดรับ คนที่ยังไม่ตอบถูกส่งไป /survey ก่อน (พากลับมาที่นี่หลังตอบ) · ตอบแล้ว/ปิดรับ = เข้าได้ตามปกติ
export default async function NewBookingPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const session = await getSession()
  if (session && (await mustAnswerSurvey(SURVEY_KEY, session.email))) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams || {})) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, x)
    redirect(`/survey?next=${encodeURIComponent('/new' + (qs.toString() ? `?${qs}` : ''))}`)
  }
  return <NewBookingClient />
}
