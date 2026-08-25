/**
 * ใครแก้ใบจองที่มีอยู่แล้วได้ "แค่ไหน" — กฎเดียว ใช้ร่วมกันทั้ง route และ UI
 *
 * v1.193 — เขียนขึ้นเพราะกฎนี้เคยถูกคัดลอกไว้ 3 ที่ (route producer-edit, หน้า
 * /bookings/:id/edit, ปุ่มในหน้า /my-bookings) แล้ว v1.188 เปิดโหมด "งาน
 * COMPLETED เติมเลข QU ได้" ที่ 2 ใน 3 ที่ ลืมปุ่มที่พาไปหน้านั้น ผลคือของจริง
 * บนพรอด 14 ใบไม่มีทางแก้เลย ทั้งที่บอทส่งเมลจี้ให้กลับมาแก้ทุกสัปดาห์
 * (operator 2026-08-24: "WLT-EXI-260826-01 ... ไปแก้เพิ่มเลข agency ref ไม่ได้")
 *
 * ทำเป็นฟังก์ชันบริสุทธิ์ตัวเดียวเพื่อให้ "เปิดโหมดใหม่แล้วลืมที่ใดที่หนึ่ง"
 * เป็นไปไม่ได้อีก
 */

export type ProducerEditMode =
  | 'full'       // REQUESTED — whitelist เต็มของเจ้าของงาน
  | 'location'   // CONFIRMED — สถานที่ + Agency Ref
  | 'agencyRef'  // COMPLETED + งาน Advertorial — เลข QU อย่างเดียว
  | 'none'       // แก้ไม่ได้

export interface ProducerEditSubject {
  status: string
  category?: string | null
  deleted?: boolean
  /** เจ้าของงาน (creator/producer) หรือทีมคิว (hasConsoleAccess) */
  authorized: boolean
}

export function producerEditMode(s: ProducerEditSubject): ProducerEditMode {
  if (!s.authorized) return 'none'
  if (s.deleted) return 'none'
  // งานที่ยกเลิกแล้วไม่ต้องตั้งเบิก จึงไม่ต้องแก้อะไรอีก
  if (s.status === 'CANCELLED') return 'none'
  if (s.status === 'REQUESTED') return 'full'
  if (s.status === 'CONFIRMED') return 'location'
  // เลข QU มักมาจากฝ่ายจัดซื้อ/ลูกค้าหลังถ่ายเสร็จ — ถ้าล็อกไว้ เจ้าของงานก็ไม่มี
  // ทางเติมเลขจริง แล้วบอทเตือนจะจี้ไปตลอดกาลโดยไม่มีทางออก. เฉพาะงาน
  // Advertorial เท่านั้น เพราะงานบ้านอื่นไม่มีเลข QU ให้ใส่ตั้งแต่ต้น
  if (s.status === 'COMPLETED') {
    return s.category === 'ADVERTORIAL' ? 'agencyRef' : 'none'
  }
  return 'none'
}

/** แก้อะไรได้บ้างในโหมดนั้น — ใช้ตัดสินทั้งการ์ดปุ่มและข้อความ */
export function canEditAgencyRef(mode: ProducerEditMode): boolean {
  return mode === 'full' || mode === 'location' || mode === 'agencyRef'
}

/**
 * สิทธิ์ **แก้ไข** ใบจอง — คนสร้าง หรือ โปรดิวเซอร์ที่ถูกระบุชื่อ
 *
 * v1.196 — ย้ายมาไว้ที่เดียวกับ producerEditMode เพราะเดิมกฎนี้ถูกเขียนซ้ำใน
 * route กับหน้า my-bookings และ "แคบกว่า" กฎการมองเห็นคนละแบบ (ดู my-bookings-scope.ts)
 * แคบกว่า "งานของฉัน" โดยตั้งใจ: ครูที่ถูก assign เห็นงานได้ แต่ไม่ควรแก้รายละเอียดงาน
 */
export function isBookingOwner(
  b: { createdByEmail?: string | null; producerEmail?: string | null },
  email: string | null | undefined,
): boolean {
  const me = (email || '').trim().toLowerCase()
  if (!me) return false
  return (b.createdByEmail || '').trim().toLowerCase() === me
    || (b.producerEmail || '').trim().toLowerCase() === me
}
