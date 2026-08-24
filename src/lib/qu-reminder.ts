/**
 * v1.187 — เตือน Producer ให้กลับมาใส่เลข QU ที่ถูกต้อง
 *
 * คำสั่ง operator (2026-08-23): *"ให้บอทส่งแจ้งเตือน Producer ที่ใส่เลข QU-1234,
 * 1234TBC หรือเว้นว่างไว้ ให้กลับมาใส่ QU ที่ถูกต้องด้วย"* — ช่องที่พูดถึงคือ
 * `Booking.agencyRef` (Agency Ref/Product Code ที่กรอกตอนจอง) ไม่ใช่ `quoteNo`
 * ของงานเช่า
 *
 * ตรรกะทั้งหมดในไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ prisma/เมล) เพื่อให้เทสจังหวะ
 * การเตือนได้โดยไม่ต้องมี DB — จังหวะคือส่วนที่พลาดแล้วกลายเป็นสแปมหรือเงียบหาย
 */
import { isQuPending } from './qu-ref'

const DAY = 86_400_000

/** ยังไม่มีเลข QU ที่ใช้ได้: เว้นว่าง หรือเป็นตัวยึด (1234 / QU-xxxxTBC) */
export function needsRealQuRef(agencyRef: string | null | undefined): boolean {
  const v = (agencyRef || '').trim()
  if (v === '') return true
  return isQuPending(v)
}

/** วันถ่ายใกล้เข้ามา = เร่งจังหวะเตือน (ค่าเริ่มต้น 3 วัน) */
export function quReminderUrgentDays(): number {
  const n = Number(process.env.QU_REMINDER_URGENT_DAYS)
  return Number.isFinite(n) && n >= 0 ? n : 3
}

export function quReminderNormalIntervalDays(): number {
  const n = Number(process.env.QU_REMINDER_INTERVAL_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 7
}

export type QuUrgency = 'urgent' | 'normal'

/**
 * ใกล้ถ่ายไหม — นับจากวันถ่าย (หรือวันสุดท้ายของงานหลายวัน) เทียบกับตอนนี้
 * งานที่ถ่ายผ่านไปแล้วไม่ใช่ "เร่ง": เลขยังต้องได้ แต่ไม่มีเส้นตายกองถ่ายแล้ว
 */
export function quUrgency(shootDate: Date | string, now: Date, urgentDays = quReminderUrgentDays()): QuUrgency {
  const d = new Date(shootDate).getTime()
  const diffDays = (d - now.getTime()) / DAY
  return diffDays >= 0 && diffDays <= urgentDays ? 'urgent' : 'normal'
}

/**
 * ถึงเวลาเตือนอีกรอบหรือยัง
 *
 * - ไม่เคยเตือน → เตือนเลย
 * - ใกล้ถ่าย (urgent) → ทุกวัน
 * - นอกนั้น → ทุก 7 วัน
 *
 * WHY ไม่เตือนทุกวันทุกใบ: เลข QU มาจากฝ่ายจัดซื้อ/ลูกค้า ไม่ได้อยู่ในมือ Producer
 * เตือนทุกวันตั้งแต่วันแรกคือสแปมที่คนจะเลิกอ่าน แล้วพอถึงใบที่เร่งจริงก็ไม่มีใครสนใจ
 * (โรคเดียวกับ badge ที่ไม่มีวันเป็น 0 ใน [[prodbooking-v184-notification-bell]])
 */
export function quReminderDue(
  lastRemindedAt: Date | null | undefined,
  urgency: QuUrgency,
  now: Date,
  opts: { urgentIntervalDays?: number; normalIntervalDays?: number } = {},
): boolean {
  if (!lastRemindedAt) return true
  const intervalDays = urgency === 'urgent'
    ? (opts.urgentIntervalDays ?? 1)
    : (opts.normalIntervalDays ?? quReminderNormalIntervalDays())
  return now.getTime() - new Date(lastRemindedAt).getTime() >= intervalDays * DAY
}

export interface QuPendingBooking {
  // v1.193 — ใช้ทำลิงก์ตรงไปหน้าแก้ของใบนั้น ๆ (query select id อยู่แล้ว)
  id?: string | null
  bookingCode: string | null
  agencyRef: string | null
  shootDate: Date | string
  status: string
  producer: string | null
  producerEmail: string | null
  quRemindedAt?: Date | null
  projectName?: string | null
}

/** จัดกลุ่มตาม Producer — เตือนเป็นสรุปฉบับเดียวต่อคน ไม่ใช่ฉบับละใบ */
export function groupByProducer(rows: QuPendingBooking[]): Map<string, QuPendingBooking[]> {
  const out = new Map<string, QuPendingBooking[]>()
  for (const r of rows) {
    const email = (r.producerEmail || '').trim().toLowerCase()
    if (!email.includes('@')) continue // ไม่มีอีเมล = เตือนไม่ได้ ผู้เรียกรายงานแยก
    out.set(email, [...(out.get(email) || []), r])
  }
  return out
}

/**
 * Producer คนนี้ควรได้เมลรอบนี้ไหม — ใบไหนใบหนึ่งถึงกำหนดก็ส่ง แล้วใส่ทุกใบที่ค้าง
 * ลงในฉบับเดียว (ไม่งั้นคนเดียวได้หลายฉบับกระจายคนละวัน)
 */
export function producerDue(rows: QuPendingBooking[], now: Date): boolean {
  return rows.some(r => quReminderDue(r.quRemindedAt, quUrgency(r.shootDate, now), now))
}

function fmtDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

/** ข้อความที่ Producer จะได้ — บอกให้ชัดว่าต้องทำอะไร ที่ไหน */
export function buildQuReminderEmail(
  rows: QuPendingBooking[],
  now: Date,
  appUrl: string,
): { subject: string; text: string } {
  const urgent = rows.filter(r => quUrgency(r.shootDate, now) === 'urgent')
  const subject = urgent.length > 0
    ? `⚠️ ขอเลข QU ด่วน — มีงานถ่ายใน ${quReminderUrgentDays()} วัน (${rows.length} งาน)`
    : `ขอเลข QU (Product Code) — ${rows.length} งานที่ยังไม่มีเลขจริง`

  const lines = rows
    .slice()
    .sort((a, b) => new Date(a.shootDate).getTime() - new Date(b.shootDate).getTime())
    .map(r => {
      const cur = (r.agencyRef || '').trim()
      const state = cur === '' ? 'ยังไม่ได้ใส่' : `ตอนนี้ใส่ "${cur}" ซึ่งเป็นตัวยึด ไม่ใช่เลขจริง`
      const flag = quUrgency(r.shootDate, now) === 'urgent' ? ' ⚠️ ใกล้ถ่าย' : ''
      const name = r.projectName ? ` · ${r.projectName}` : ''
      // v1.193 — ลิงก์ตรงไปหน้าแก้ของใบนั้นเลย: เดิมส่งไป /my-bookings เฉย ๆ แล้ว
      // ให้ผู้รับไปหาปุ่มเอง ซึ่งงาน COMPLETED ไม่มีปุ่มด้วยซ้ำ (บั๊ก v1.188)
      const link = r.id ? `\n  ${appUrl}/bookings/${r.id}/edit` : ''
      return `• ${r.bookingCode || '(ไม่มีรหัส)'}${name} — ถ่าย ${fmtDate(r.shootDate)}${flag}\n  ${state}${link}`
    })

  const text =
    `สวัสดีครับ — งานเอเจนซีข้างล่างนี้ยังไม่มีเลขใบเสนอราคา (QU) ที่ใช้ได้จริง\n` +
    `เลขนี้คือช่อง Agency Ref / Product Code ที่กรอกตอนจอง และเป็นตัวที่ใช้ตั้งเบิก\n\n` +
    `${lines.join('\n')}\n\n` +
    `ได้เลข QU แล้วกดลิงก์ของงานนั้นเพื่อเติมเลขได้เลยครับ (รูปแบบ QU-4289)\n` +
    `รวมงานทั้งหมดของคุณ: ${appUrl}/my-bookings\n\n` +
    `ถ้ายังไม่ได้เลข ไม่ต้องทำอะไร ระบบจะเตือนอีกครั้งในสัปดาห์หน้า\n` +
    `(งานที่ใกล้ถ่ายจะเตือนถี่ขึ้นเป็นทุกวัน)\n\n` +
    `— Production Booking`

  return { subject, text }
}
