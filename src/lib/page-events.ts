/**
 * v1.190 — บันทึก "ใครเปิดหน้าไหนเมื่อไหร่" แบบแคบ ๆ
 *
 * WHY. ระบบมีฟีเจอร์ที่ข้อมูลพร้อมแต่ไม่มีใครใช้อยู่หลายตัว (OT 551 ใบ ส่ง 0 ·
 * ปุ่มส่งงานไม่เคยถูกกด · อัปโหลดมีคนใช้คนเดียว) และทุกครั้งที่ถามว่า "ทำไมไม่มี
 * ใครใช้" เราตอบไม่ได้ เพราะแยกไม่ออกระหว่าง **ไม่รู้ว่ามี** กับ **เข้าไปแล้ว
 * ยอมแพ้** — ซึ่งแก้คนละทางกันสิ้นเชิง audit_logs ตอบได้แค่ "ลงมือทำอะไรบ้าง"
 * ไม่ได้ตอบ "เปิดดูแล้วเงียบไป"
 *
 * ตั้งใจให้เล็กที่สุดที่ยังตอบคำถามได้:
 *   - เก็บแค่ email + path + เวลา · **ไม่เก็บ** IP, user-agent, referrer, query string
 *   - เฉพาะหน้าที่มีคำถามค้างอยู่จริง (ALLOWLIST) ไม่ใช่ทุกหน้า
 *   - path ถูก normalize ตัด id ออก (/dashboard/abc123 → /dashboard/:id) เพราะเรา
 *     อยากรู้ว่า "เปิดหน้าอะไร" ไม่ใช่ "เปิดงานใบไหน" (ใบไหนมีใน audit อยู่แล้ว)
 *   - ไม่ใช้ tracker ภายนอก ไม่มี cookie เพิ่ม — เป็นตารางของเราเอง
 */

/**
 * หน้าที่เก็บ — คุมด้วยรายการนี้เท่านั้น ไม่ใช่เก็บหมดแล้วค่อยกรอง
 *
 * เพิ่มเมื่อมี "คำถามที่ตอบไม่ได้" จริง ๆ ไม่ใช่เพิ่มไว้เผื่อ — ข้อมูลที่ไม่มีใคร
 * ตั้งใจจะอ่านคือภาระ ไม่ใช่สินทรัพย์
 */
export const TRACKED_PATHS = [
  '/ot',          // pilot สิ้นเดือน ส.ค. 2026 — คำถาม: คนรู้จักไหม เข้าแล้วส่งไหม
  '/ot/admin',    // ฝั่งผู้อนุมัติ
  '/new',         // ฟอร์มจอง — เข้าแล้วจองจบไหม
  '/upload',      // อัปโหลด — ตายจริงหรือแค่ไม่มีใครรู้
  '/my-bookings',
  '/admin',
] as const

/**
 * ตัด id/ตัวแปรออกจาก path แล้วคืนค่าที่อยู่ใน ALLOWLIST เท่านั้น
 * คืน null = ไม่ต้องเก็บ (เป็นค่าที่ผู้เรียกต้องเคารพ ทั้งฝั่ง client และ server)
 *
 * เทียบแบบยาวสุดก่อน (/ot/admin ต้องไม่ถูกจับเป็น /ot)
 */
export function normalizeTrackedPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // ตัด query/hash ทิ้งตั้งแต่ต้นทาง — ไม่เก็บ query string โดยเจตนา
  let p = raw.split('?')[0].split('#')[0].trim()
  if (!p.startsWith('/')) return null
  // ตัด trailing slash (ยกเว้น root)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)

  const candidates = [...TRACKED_PATHS].sort((a, b) => b.length - a.length)
  for (const t of candidates) {
    if (p === t) return t
    // path ย่อยที่มี id ต่อท้าย → นับเป็นหน้าแม่ แต่ไม่เก็บ id
    if (p.startsWith(t + '/')) return t
  }
  return null
}

/**
 * ช่วงเวลาที่ถือว่าเป็น "การเข้าใช้ครั้งเดียวกัน" — กันการกด refresh / re-render
 * ทำให้เกิดแถวซ้ำจนตัวเลขเฟ้อ. 30 นาทีคือนิยาม session แบบที่ใช้กันทั่วไป
 */
export const VISIT_WINDOW_MS = 30 * 60 * 1000

/** ควรบันทึกแถวใหม่ไหม เมื่อครั้งล่าสุดของ (คน, หน้า) นี้คือ `lastAt` */
export function shouldRecordVisit(lastAt: Date | null | undefined, now: Date): boolean {
  if (!lastAt) return true
  return now.getTime() - new Date(lastAt).getTime() >= VISIT_WINDOW_MS
}

export function pageEventsEnabled(): boolean {
  return process.env.PAGE_EVENTS_ENABLED?.trim() !== '0'
}
