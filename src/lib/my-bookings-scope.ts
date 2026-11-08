/**
 * "งานของฉัน" คืออะไร — นิยามเดียว ใช้ทั้งฝั่ง query และฝั่ง UI
 *
 * v1.196 — เดิม `/api/bookings?scope=mine` กรองด้วย **คนสร้าง หรือ เป็นครูในงาน**
 * เท่านั้น ไม่มี "เป็นโปรดิวเซอร์ของงาน" อยู่ในเงื่อนไขเลย ผลบนพรอด 2026-08-25:
 * **59 ใบที่โปรดิวเซอร์ของงานเองมองไม่เห็นในหน้า My Bookings**
 *
 * ทำไมถึงร้ายแรง: บอท QU ส่งเมลไปหา `producerEmail` พร้อมข้อความ "รบกวนกลับมาแก้
 * ที่ใบจอง" + ลิงก์ไป /my-bookings — แต่ใบนั้นไม่เคยอยู่ในลิสต์ของเขาเลย
 * ในงาน AD ที่ยังไม่มีเลข QU 17 ใบ มี **8 ใบที่คนถูกเตือนมองไม่เห็นใบจอง**
 * (รวม WLT-EXI-260826-01 ที่ operator แจ้งเข้ามาเมื่อ 2026-08-24)
 *
 * ต้นเหตุเชิงโครงสร้าง: คำว่า "ของฉัน" ถูกนิยามไว้คนละแบบสองที่ —
 *   - สิทธิ์ **แก้ไข** = คนสร้าง หรือ producerEmail   (producer-edit route)
 *   - สิทธิ์ **มองเห็น** = คนสร้าง หรือ assignedEmails (scope=mine)
 * สองอันนี้ควรครอบคลุมกัน แต่ไม่มีใครเทียบเพราะอยู่คนละไฟล์
 *
 * ที่นี่คือ "มองเห็น" — กว้างกว่า "แก้ไข" เสมอโดยตั้งใจ
 * (ดูสิทธิ์แก้ไขที่ `isBookingOwner` ใน producer-edit-access.ts)
 */

export interface MyBookingParty {
  createdByEmail?: string | null
  producerEmail?: string | null
  coProducerEmail?: string | null
  assignedEmails?: string[] | null
}

const eq = (a: string | null | undefined, email: string) =>
  !!a && a.trim().toLowerCase() === email

/** งานนี้เป็น "งานของฉัน" ไหม — ฉันถูกระบุชื่อไว้ในบทบาทใดบทบาทหนึ่ง */
export function isMyBooking(b: MyBookingParty, email: string | null | undefined): boolean {
  const me = (email || '').trim().toLowerCase()
  if (!me) return false
  return eq(b.createdByEmail, me)
    || eq(b.producerEmail, me)
    || eq(b.coProducerEmail, me)
    || (b.assignedEmails || []).some(e => eq(e, me))
}

/**
 * Prisma where-clause ของ `scope=mine` — ต้องให้ผลตรงกับ isMyBooking
 * (เทสล็อกไว้ว่าทุกบทบาทใน isMyBooking มีสาขาใน OR นี้)
 *
 * `assignedIds` = ผลของ assignedBookingIdsCI(email) — ส่งมาเมื่อไหร่ใบที่ชื่อครู
 * เก็บเป็นตัวพิมพ์ใหญ่ปน ('Name.S@…') ถึงจะโผล่ด้วย · ไม่ส่ง = `has` ตรงตัวพิมพ์อย่างเดียว
 * (มีสิทธิ์อัปโหลดแต่มองไม่เห็นใบ — คลาส 10)
 */
export function myBookingsWhere(email: string, assignedIds: string[] = []) {
  const me = email.trim().toLowerCase()
  const ci = { equals: me, mode: 'insensitive' as const }
  return {
    OR: [
      { createdByEmail: ci },
      { producerEmail: ci },
      { coProducerEmail: ci },
      { assignedEmails: { has: me } },
      ...(assignedIds.length ? [{ id: { in: assignedIds } }] : []),
    ],
  }
}

/**
 * maint 2026-11-08 — ใบที่ฉันอยู่ใน assignedEmails แต่สะกดตัวพิมพ์ต่างจากอีเมลล็อกอิน
 *
 * Prisma `has` บน text[] สนตัวพิมพ์ และ cleanEmailList (email-list.ts) ตั้งใจไม่
 * lowercase ตอนเก็บ (พรอดมีทั้ง sound@ / Sound@) ขณะที่ isMyBooking และ
 * canUploadToBooking ไม่สนตัวพิมพ์ ⇒ ครูอัปโหลดได้แต่ใบไม่โผล่ใน scope=mine
 * คืนเฉพาะใบที่ `has` จับไม่ได้ ลิสต์จึงสั้น (ปกติว่าง)
 */
export async function assignedBookingIdsCI(email: string): Promise<string[]> {
  const me = email.trim().toLowerCase()
  if (!me) return []
  const { prisma } = await import('./db')
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM bookings
    WHERE NOT (${me} = ANY("assignedEmails"))
      AND EXISTS (SELECT 1 FROM unnest("assignedEmails") AS e WHERE lower(trim(e)) = ${me})`
  return rows.map(r => r.id)
}

/** ชื่อบทบาทที่นับว่าเป็น "งานของฉัน" — ใช้ในเทสกันสองฝั่งหลุดจากกัน */
export const MY_BOOKING_ROLE_FIELDS = [
  'createdByEmail', 'producerEmail', 'coProducerEmail', 'assignedEmails',
] as const
