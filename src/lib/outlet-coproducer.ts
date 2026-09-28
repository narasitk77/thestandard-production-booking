/**
 * v1.183 — Co-Producer ประจำ outlet ที่ระบบเติมให้เอง
 *
 * v1.242 (28 ก.ย. 2569) — แก้วออกจากทีม operator ให้แพรดูแล TSS คนเดียว ตารางค่าตั้งต้น
 * จึงว่าง กลไกยังอยู่ครบ — บนพรอดเปิดกลับได้ทางเดียวคือเติมตารางนี้แล้ว deploy (compose ส่งแค่
 * สวิตช์รวม AUTO_COPRODUCER ไม่ส่ง AUTO_COPRODUCER_<CODE> → ค่านั้นไม่ถึง container) — ดู
 * docs/runbook-offboarding.md ว่าทำไมคนที่ออกต้องถูกถอดจาก "กฎ" ที่นี่ ไม่ใช่แค่ปิด active
 *
 * คำสั่ง operator (2026-08-20): "งานของ TSS ทุกงานหลังจากนี้ ให้ยิงแก้ว co-po TSS
 * ในคิวด้วย" — งานที่จองเข้ามาใหม่ของ TSS ต้องมีแก้วเป็น Co-Producer ติดอยู่ในคิว
 * โดยที่คนจองไม่ต้องเลือกเอง
 *
 * กติกา (ตามที่ operator ยืนยัน): **เคารพคนกรอกก่อนเสมอ** — เติมให้เฉพาะตอนที่
 * ช่อง Co-Producer ว่างจริง ๆ ถ้าคนจองเลือกคนอื่นไว้แล้ว ระบบไม่แตะ
 *
 * ทำแบบเดียวกับ VP auto-assign (vp-assign.ts): seed ตอน CREATE ฝั่ง server
 * เท่านั้น — ไม่ preselect ในฟอร์ม เพราะ dropdown ฝั่ง client มีผลกับ validation
 * "เลือก Producer หรือ Co-Producer อย่างน้อย 1 คน" (BookingWizard) ถ้า preselect
 * ให้ จะกลายเป็นว่าจองงาน TSS โดยไม่มี Producer เลยก็ผ่าน
 *
 * Kill switch: AUTO_COPRODUCER=0 ปิดได้ทันทีจาก stack env (ไม่ต้อง deploy)
 * Override รายเจ้า: AUTO_COPRODUCER_TSS="email" หรือ "email|ชื่อเล่น" (ถึง container เฉพาะเมื่อ
 * compose ประกาศ key นั้น — docker-compose.portainer.yml ยังไม่ประกาศ ใช้ได้แค่เทส/dev)
 *
 * หมายเหตุแบบเดียวกับ vp-assign: env ที่ไม่ใช่ NEXT_PUBLIC_ ถูก compile ทิ้งใน
 * client bundle — ฝั่งเบราว์เซอร์จะเห็นค่า default เสมอ ที่นี่ใช้แค่ข้อความ hint
 * ในฟอร์ม ตัวที่เขียนลง DB จริงคือฝั่ง server เท่านั้น
 */

export interface DefaultCoProducer {
  /** ชื่อเล่น — ค่าที่เก็บลง Booking.coProducer (คอลัมน์นี้เก็บชื่อเล่น) */
  nickname: string
  /** อีเมล — ค่าที่เก็บลง Booking.coProducerEmail (id หลักของคน) */
  email: string
}

/**
 * ค่าตั้งต้นในโค้ด — **ว่างตั้งแต่ v1.242** (แก้ว TSS ออก 28 ก.ย. 2569 ไม่มีคนแทน)
 * ถ้าจะตั้งคนใหม่: ต้องเป็นคนเดียวกับ seed ใน outlet-producers.ts (ไม่งั้นชื่อในคิว
 * จะไม่ใช่คนใน dropdown) และเมื่อคนนั้นออก ต้องถอดออกจากที่นี่ด้วย — users.active=false
 * ไม่ได้หยุดกฎนี้ เพราะกฎอ่านจากตารางนี้ ไม่ได้ join users
 */
export const BUILT_IN_DEFAULT_COPRODUCERS: Record<string, DefaultCoProducer> = {}

export function autoCoProducerEnabled(): boolean {
  return process.env.AUTO_COPRODUCER?.trim() !== '0'
}

/**
 * Co-Producer ที่ระบบจะเติมให้ outlet นี้ — null = outlet นี้ไม่มีกติกานี้
 * (ปิดสวิตช์ / ไม่มีในตาราง / env override ใส่ค่าเสียจนหาอีเมลไม่เจอ)
 */
export function defaultCoProducerFor(outletCode: string | null | undefined): DefaultCoProducer | null {
  if (!autoCoProducerEnabled()) return null
  const code = (outletCode || '').trim().toUpperCase()
  if (!code) return null

  const builtIn = BUILT_IN_DEFAULT_COPRODUCERS[code] || null

  // AUTO_COPRODUCER_<CODE> — "email" หรือ "email|ชื่อเล่น"; ค่าว่าง = ปิดเฉพาะ outlet นี้
  const raw = process.env[`AUTO_COPRODUCER_${code}`]
  if (raw === undefined) return builtIn
  const [emailRaw, nickRaw] = raw.split('|')
  const email = (emailRaw || '').trim()
  if (!email) return null
  const nickname = (nickRaw || '').trim() || builtIn?.nickname || email.split('@')[0]
  return { nickname, email }
}

/**
 * ตัดสินว่าจะเติม Co-Producer ให้ booking ใบนี้ไหม แล้วคืนค่าที่ควรบันทึก
 *
 * ไม่เติมเมื่อ: คนจองเลือก Co-Producer มาแล้ว (ชื่อหรืออีเมลอย่างใดอย่างหนึ่ง),
 * หรือคนคนนั้นเป็น Producer ของงานนี้อยู่แล้ว (เช่น outlet ที่เลื่อน Co-Pro ขึ้น
 * เป็น Producer เมื่อไม่มี Producer — จะได้ไม่โผล่ซ้ำสองช่อง)
 */
export function applyDefaultCoProducer(input: {
  outletCode: string | null | undefined
  coProducer: string | null | undefined
  coProducerEmail: string | null | undefined
  producerEmail: string | null | undefined
}): { coProducer: string | null; coProducerEmail: string | null; autoFilled: boolean } {
  const coProducer = (input.coProducer || '').trim() || null
  const coProducerEmail = (input.coProducerEmail || '').trim() || null
  if (coProducer || coProducerEmail) return { coProducer, coProducerEmail, autoFilled: false }

  const def = defaultCoProducerFor(input.outletCode)
  if (!def) return { coProducer, coProducerEmail, autoFilled: false }

  const producerEmail = (input.producerEmail || '').trim().toLowerCase()
  if (producerEmail && producerEmail === def.email.toLowerCase()) {
    return { coProducer, coProducerEmail, autoFilled: false }
  }

  return { coProducer: def.nickname, coProducerEmail: def.email, autoFilled: true }
}
