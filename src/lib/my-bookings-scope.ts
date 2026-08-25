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
 */
export function myBookingsWhere(email: string) {
  const me = email.trim().toLowerCase()
  const ci = { equals: me, mode: 'insensitive' as const }
  return {
    OR: [
      { createdByEmail: ci },
      { producerEmail: ci },
      { coProducerEmail: ci },
      { assignedEmails: { has: me } },
    ],
  }
}

/** ชื่อบทบาทที่นับว่าเป็น "งานของฉัน" — ใช้ในเทสกันสองฝั่งหลุดจากกัน */
export const MY_BOOKING_ROLE_FIELDS = [
  'createdByEmail', 'producerEmail', 'coProducerEmail', 'assignedEmails',
] as const
