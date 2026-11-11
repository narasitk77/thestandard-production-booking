/**
 * v1.278 — ฝั่ง server ของแบบสำรวจ: เปิด/ปิดรับคำตอบ, ใครมีสิทธิ์ตอบ, บันทึกคำตอบ
 * (นิยามคำถาม + กฎตรวจคำตอบอยู่ที่ survey.ts ซึ่งหน้า client ใช้ร่วม)
 */
import { prisma } from './db'
import { validateOverrides, type Answers, type Overrides, type Segment } from './survey'

const openKey = (key: string) => `survey-open:${key}`
const textKey = (key: string) => `survey-text:${key}`

/** ปิดเป็นค่าเริ่มต้น — deploy แล้วยังไม่ชวนใคร จนกว่าแอดมินกดเปิดที่ /admin/survey */
export async function isSurveyOpen(key: string): Promise<boolean> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { key: openKey(key) } })
  return row?.note === 'open'
}

export async function setSurveyOpen(key: string, open: boolean): Promise<void> {
  const at = new Date(), note = open ? 'open' : 'closed'
  await prisma.systemHeartbeat.upsert({ where: { key: openKey(key) }, create: { key: openKey(key), at, note }, update: { at, note } })
}

/**
 * v1.279.3 — คำที่แอดมินแก้บนจอ (ดู Overrides ใน survey.ts) เก็บเป็น JSON ใน system_heartbeats.note คู่กับธงเปิด/ปิด
 * ponytail: ยืมตาราง heartbeat แทนเพิ่มตาราง — เปลี่ยน schema = ถอยอิมเมจแล้ว DROP (ดู deploy.py) · ย้ายเมื่อมี setting ตัวที่สาม
 * แถวเสีย (JSON พัง / ไม่ผ่าน validate) = throw ให้หน้า/API ล้มดัง ๆ ไม่ใช่เงียบ ๆ กลับไปใช้คำในโค้ด
 */
export async function getSurveyText(key: string): Promise<Overrides | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { key: textKey(key) } })
  if (!row?.note) return null
  let parsed: unknown
  try { parsed = JSON.parse(row.note) } catch { throw new Error(`คำที่แก้ไว้ของแบบสำรวจ (${textKey(key)}) อ่านไม่ออก — ให้แอดมินกด "กลับไปใช้คำในโค้ด"`) }
  const v = validateOverrides(parsed)
  if (!v.ok) throw new Error(`คำที่แก้ไว้ของแบบสำรวจไม่ตรงกับชุดคำถามปัจจุบัน: ${v.error}`)
  return v.value
}

export async function setSurveyText(key: string, ov: Overrides | null): Promise<void> {
  const k = textKey(key), at = new Date(), note = ov ? JSON.stringify(ov) : null
  await prisma.systemHeartbeat.upsert({ where: { key: k }, create: { key: k, at, note }, update: { at, note } })
}

/** ช่วงเวลาที่นับว่า "เป็นคนจองงาน" — สร้าง หรือเป็น Producer / Co-Producer ของใบที่ถ่ายภายใน 180 วัน */
const BOOKER_WINDOW_MS = 180 * 24 * 3_600_000

/**
 * v1.285.1 — ทุกคนที่ล็อกอินตอบได้ (เดิม v1.278–v1.285.0 จำกัดเฉพาะคนจองคิว ทีมจัดคิวตอบไม่ได้) · นัทสั่ง 11 พ.ย.:
 * "ใครล็อกอินเข้ามาก็ให้ตอบ … แบ่งกล่องไว้ก็ได้ เผื่อมีคนไม่เคยใช้มาตอบ จะได้วัดได้"
 * กล่อง = ว่าเป็น "คนจองคิว" ไหม ณ ตอนตอบ (สร้าง / Producer / Co-Producer ของใบที่ถ่ายใน 180 วัน) → ลงในคำตอบเป็น `seg`
 * ใช้แยกผลเป็น 2 ก้อน (ใช้จริง vs ไม่ได้จองเอง) — ไม่ใช่ด่านกั้นสิทธิ์
 */
export async function surveySegment(email: string): Promise<Segment> {
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
  return n > 0 ? 'booker' : 'other'
}

/** จำนวนคนที่ตอบได้ = บัญชีที่ active ทั้งหมด — ใช้คิดอัตราการตอบในหน้าผล */
export async function eligibleCount(): Promise<number> {
  return prisma.user.count({ where: { active: true } })
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
export async function saveSurveyAnswer(key: string, email: string, group: string, answers: Answers): Promise<'ok' | 'duplicate'> {
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
