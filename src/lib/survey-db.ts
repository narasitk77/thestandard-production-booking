/**
 * v1.278 — ฝั่ง server ของแบบสำรวจ: เปิด/ปิดรับคำตอบ, ใครมีสิทธิ์ตอบ, บันทึกคำตอบ
 * (นิยามคำถาม + กฎตรวจคำตอบอยู่ที่ survey.ts ซึ่งหน้า client ใช้ร่วม)
 */
import { prisma } from './db'
import { hasConsoleAccess } from './roles'
import type { Answers, Group } from './survey'

const openKey = (key: string) => `survey-open:${key}`

/** ปิดเป็นค่าเริ่มต้น — deploy แล้วยังไม่ชวนใคร จนกว่าแอดมินกดเปิดที่ /admin/survey */
export async function isSurveyOpen(key: string): Promise<boolean> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { key: openKey(key) } })
  return row?.note === 'open'
}

export async function setSurveyOpen(key: string, open: boolean): Promise<void> {
  const at = new Date(), note = open ? 'open' : 'closed'
  await prisma.systemHeartbeat.upsert({ where: { key: openKey(key) }, create: { key: openKey(key), at, note }, update: { at, note } })
}

/** ช่วงเวลาที่นับว่า "เป็นคนจองงาน" — สร้าง หรือเป็น Producer / Co-Producer ของใบที่ถ่ายภายใน 180 วัน */
const BOOKER_WINDOW_MS = 180 * 24 * 3_600_000

/**
 * คนที่แบบสำรวจนี้ถามได้ = ทีมจัดคิว (สิทธิ์คอนโซล) หรือคนที่จอง/เป็น Producer ของใบใน 180 วัน
 * (นัทสั่ง 3 พ.ย.: เอาแค่คนจองงานกับทีมจัดคิว — ทีมกองไม่ถาม)
 */
export async function isSurveyEligible(email: string, role: string | null | undefined): Promise<boolean> {
  if (hasConsoleAccess(role)) return true
  const n = await prisma.booking.count({
    where: {
      deletedAt: null,
      shootDate: { gte: new Date(Date.now() - BOOKER_WINDOW_MS) },
      OR: [
        { createdByEmail: { equals: email, mode: 'insensitive' } },
        { producerEmail: { equals: email, mode: 'insensitive' } },
        { coProducerEmail: { equals: email, mode: 'insensitive' } },
      ],
    },
  })
  return n > 0
}

/** จำนวนคนที่มีสิทธิ์ตอบ (บัญชี active) — ใช้คิดอัตราการตอบในหน้าผล */
export async function eligibleCount(): Promise<number> {
  const since = new Date(Date.now() - BOOKER_WINDOW_MS)
  const [users, bookings] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { email: true, role: true } }),
    prisma.booking.findMany({ where: { deletedAt: null, shootDate: { gte: since } }, select: { createdByEmail: true, producerEmail: true, coProducerEmail: true } }),
  ])
  const bookers = new Set<string>()
  for (const b of bookings) for (const e of [b.createdByEmail, b.producerEmail, b.coProducerEmail]) if (e) bookers.add(e.toLowerCase())
  return users.filter(u => hasConsoleAccess(u.role) || bookers.has(u.email.toLowerCase())).length
}

/** Fisher–Yates — สุ่มลำดับจริง (sort แบบ random comparator เอียงตามลำดับเดิม) */
export function shuffled<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

/**
 * บันทึกคำตอบ 1 ชุด: แถวคนตอบ + เขียนคำตอบ "ทั้งรอบ" ใหม่ในลำดับสุ่ม ใน transaction เดียว
 *
 * ทำไมไม่ insert ทีละแถว (รีวิว v1.278): แถวคนตอบกับแถวคำตอบที่ insert ใน tx เดียวกันได้ xmin เดียวกัน
 * (`JOIN ... ON p.xmin = r.xmin` ได้อีเมลคู่คำตอบครบ) และสองตารางเพิ่มท้ายอย่างเดียวจึงเรียงตรงกันใน pg_dump
 * เขียนใหม่ทั้งชุด = ทุกแถวคำตอบได้ xmin ของรอบล่าสุดและตำแหน่งสุ่ม — advisory lock กันคนส่งพร้อมกัน
 * (ไม่งั้น tx ที่สองมองไม่เห็นแถวของ tx แรก แล้วแถวของตัวเองจะเหลือ xmin ตรงกับคนตอบอยู่แถวเดียว)
 * ตอบซ้ำ = unique ของ survey_participants ชน → 'duplicate' (ไม่มีอะไรถูกเขียน)
 * ponytail: อ่าน-ลบ-เขียนทั้งชุดต่อหนึ่งคำตอบ — O(n) ต่อครั้ง ไม่กี่สิบแถวต่อรอบจึงไม่เป็นไร
 */
export async function saveSurveyAnswer(key: string, email: string, group: Group, answers: Answers): Promise<'ok' | 'duplicate'> {
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'survey:' + key}))`
      // เช็กใต้ lock ก่อน — ตอบซ้ำเป็นเรื่องปกติ ไม่ควรขึ้นเป็น prisma:error ใน log (P2002 ข้างล่างเหลือไว้เป็นด่านสำรอง)
      if (await tx.surveyParticipant.findUnique({ where: { surveyKey_email: { surveyKey: key, email: email.toLowerCase() } } })) return 'duplicate' as const
      await tx.surveyParticipant.create({ data: { surveyKey: key, email: email.toLowerCase() } })
      const old = await tx.surveyResponse.findMany({ where: { surveyKey: key }, select: { group: true, answers: true } })
      await tx.surveyResponse.deleteMany({ where: { surveyKey: key } })
      const all = shuffled([...old.map(r => ({ group: r.group, answers: r.answers as object })), { group, answers }])
      await tx.surveyResponse.createMany({ data: all.map(r => ({ surveyKey: key, group: r.group, answers: r.answers })) })
      return 'ok' as const
    })
  } catch (e: any) {
    if (e?.code === 'P2002') return 'duplicate'
    throw e
  }
}

export async function hasAnswered(key: string, email: string): Promise<boolean> {
  const row = await prisma.surveyParticipant.findUnique({ where: { surveyKey_email: { surveyKey: key, email: email.toLowerCase() } } })
  return !!row
}
