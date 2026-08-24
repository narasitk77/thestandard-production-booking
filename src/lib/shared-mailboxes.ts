/**
 * v1.191 — กล่องอีเมลกลางของทีม (ไม่ใช่คน)
 *
 * WHY. `Booking.assignedEmails` ใส่ได้ทั้งคนจริงและ "ทีม" เช่น `video@` / `sound@`
 * ซึ่งสะดวกตอนจัดคิว (หมายถึง "ทีมวิดีโอไปกันเอง") แต่พังทันทีที่ระบบอื่นเอาไป
 * ตีความว่าเป็นบุคคล — ของจริงบนพรอด (2026-08-24): OT สร้างร่างให้ `video@` 113 ใบ
 * และ `sound@` 90 ใบ รวม **203 จาก 513 ใบ (40%) ตกอยู่กับกล่องที่ไม่มีเจ้าของ**
 * ไม่มีใครกดส่งได้ และทำให้ตัวเลข funnel ของ pilot ดูแย่กว่าความจริง
 *
 * **ใช้รายชื่อชัดเจน ไม่ใช้ heuristic** — เคยคิดจะเดาจาก "local-part ไม่มีจุด"
 * (คนใช้ firstname.lastname) แต่ตรวจข้อมูลจริงแล้วเจอ `bickboon@thestandard.co`
 * ซึ่งเป็นคนจริงและไม่มีจุด → เดาผิดแล้วตัดคนจริงออกจาก OT เงียบ ๆ
 *
 * เพิ่มกล่องใหม่ได้โดยไม่ต้อง deploy: `SHARED_MAILBOXES="a@x.co,b@x.co"` (แทนที่ทั้งชุด)
 */

/** ยืนยันจากข้อมูลจริงบนพรอด: ทุกตัวชื่อ "<ทีม> THE STANDARD" ไม่มี position */
export const DEFAULT_SHARED_MAILBOXES = [
  'video@thestandard.co',
  'sound@thestandard.co',
  'photo@thestandard.co',
  'podcast@thestandard.co',
  'event@thestandard.co',
  'webmaster@thestandard.co',
] as const

export function sharedMailboxes(): string[] {
  const raw = process.env.SHARED_MAILBOXES?.trim()
  if (!raw) return [...DEFAULT_SHARED_MAILBOXES]
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(e => e.includes('@'))
  return list.length > 0 ? list : [...DEFAULT_SHARED_MAILBOXES]
}

/** อีเมลนี้เป็นกล่องกลางของทีม ไม่ใช่คน */
export function isSharedMailbox(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase()
  if (!e) return false
  return sharedMailboxes().includes(e)
}

/**
 * ตัดกล่องกลางออกจากรายชื่อ — ใช้ตอนที่ปลายทางต้องเป็น "บุคคล" เท่านั้น
 * (เช่น สร้างร่าง OT ที่ต้องมีคนกดส่งและเซ็นชื่อ)
 *
 * **อย่าใช้กับการแจ้งข่าว**: กล่องกลางคือช่องทางที่ทีมอ่านจริง การตัดออกจากเมล
 * แจ้งฟุตเทจจะทำให้ทีมไม่ได้ยิน (ดู footage-ready ที่จงใจเก็บ video@/sound@ ไว้)
 */
export function excludeSharedMailboxes(emails: (string | null | undefined)[]): string[] {
  return emails
    .map(e => (e || '').trim())
    .filter(e => e !== '' && !isSharedMailbox(e))
}
