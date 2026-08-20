/**
 * v1.161 — กฏ Agency ref (คำสั่ง operator 2026-08-03): งาน Agency (Advertorial)
 * ต้องมีเลขใบเสนอราคารูปแบบ QU เท่านั้น — และถ้าเว้นว่างมา ให้ดึงจาก DB เอง
 * (คิวก่อนหน้าของโปรเจกต์เดียวกันพกเลขนี้อยู่แล้ว — เคสจริง: AGN-260713-01
 * ใส่ EP id มาแทน ทั้งที่ QU-4480 อยู่ในคิวก่อนหน้าของโปรเจกต์เดียวกัน)
 *
 * รูปแบบที่ถือว่าถูก อิงจากข้อมูลจริงในระบบ: QU-4289, QU-4426-V1, QU-2811/2,
 * QU4406 — ขึ้นต้น QU ตามด้วยตัวเลข อนุญาตตัวอักษร/ตัวเลข กับ "-" และ "/"
 * เป็นตัวคั่นส่วนต่อท้าย
 *
 * v1.183 — แยกออกมาจาก agency-ref.ts เพราะไฟล์นั้น import prisma: ฟอร์มจอง
 * (client bundle) ต้องใช้ predicate ชุดเดียวกับ server โดยไม่ลาก Prisma เข้า
 * bundle ไปด้วย. agency-ref.ts re-export ทุกตัวจากที่นี่ ของเดิมจึงไม่พัง.
 *
 * Kill switch: AGENCY_REF_QU_RULE=0 ปิดกฏได้ทันทีจาก stack env (ไม่ต้อง deploy)
 * เผื่อกฏไปขวางงานจองหน้างานแบบไม่คาดคิด
 */

export function quRuleEnabled(): boolean {
  return process.env.AGENCY_REF_QU_RULE?.trim() !== '0'
}

/** ตัดช่องว่าง + uppercase — "qu 4289" → "QU4289", " QU-4289 " → "QU-4289" */
export function normalizeQuRef(raw: string | null | undefined): string {
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '')
}

const QU_RE = /^QU-?\d+[A-Z0-9/-]*$/

/** อยู่ในรูปแบบเลข QU (ยังไม่ตัดสินว่าเป็นเลขจริงหรือตัวยึด) */
function matchesQuFormat(n: string): boolean {
  return n !== '' && QU_RE.test(n)
}

/** เลขใบเสนอราคาจริง — ตัวยึด "ยังไม่มีเลข QU" ไม่นับ (ดู isQuPending) */
export function isValidQuRef(raw: string | null | undefined): boolean {
  const n = normalizeQuRef(raw)
  return matchesQuFormat(n) && !isQuPending(raw)
}

/**
 * v1.183 — "ยังไม่มีเลข QU" (คำสั่ง operator 2026-08-20: "บางงานยังไม่มี QU
 * ใส่เป็น 1234 ได้ไหม").
 *
 * ตัวยึดที่ยอมรับคือ "1234" เปล่า ๆ เท่านั้น — จงใจไม่นับ "QU-1234" ด้วย:
 * QU-1234 อยู่ในรูปแบบเลขใบเสนอราคาจริง ถ้าเหมาเป็น placeholder แล้ววันหนึ่ง
 * มีใบเสนอราคาเลขนั้นจริง เราจะเขียนทับของจริงโดยไม่มีใครรู้. "1234" เปล่า ๆ
 * ตกกฏ QU อยู่แล้ว จึงไม่มีทางชนกับเลขจริง — ปลอดภัยที่สุดในการเก็บตามที่พิมพ์
 * (ค่าที่เก็บลง DB = "1234" ตรง ๆ ค้นหาเจอทุกที่ที่ค้น Agency Ref ได้)
 */
export const QU_PENDING = '1234'

/**
 * งานนี้ "ยังไม่มีเลข QU" — ใส่ตัวยึดไว้ก่อน ต้องกลับมาเติมเลขจริงทีหลัง
 *
 * นับสองแบบ:
 *   1. "1234" — ตัวยึดที่เราประกาศให้คนใช้ (v1.183)
 *   2. เลขรูปแบบ QU ที่มี "TBC" ติดอยู่ เช่น "QU-1234TBC" — ตัวยึดที่ทีมคิดขึ้น
 *      เองก่อนจะมีข้อ 1 และ **มีอยู่จริงบนพรอด** (PP-26-047 / AGN-260824-01,-02)
 *      ของพวกนี้ผ่าน QU_RE เพราะ TBC เป็นตัวอักษรท้ายเลข → เดิมถูกนับเป็น "เลขจริง"
 *      แล้ว pullQuRefFromProject ก็ลากไปใส่คิวถัดไปของโปรเจกต์เดียวกันเงียบ ๆ
 *      พอจัดเป็นตัวยึด รูนี้ปิดเอง และ badge "ยังไม่มีเลข QU" ก็ขึ้นให้เห็น
 *
 * ค่าที่เก็บไว้แล้วไม่ถูกแตะ — เปลี่ยนแค่การจัดประเภท (แก้ไขต่อได้ปกติเพราะ
 * isAcceptableQuRef ยังผ่าน)
 */
export function isQuPending(raw: string | null | undefined): boolean {
  const n = normalizeQuRef(raw)
  if (n === QU_PENDING) return true
  return matchesQuFormat(n) && n.includes('TBC')
}

/** ผ่านการตรวจ = เป็นเลข QU จริง หรือเป็นตัวยึด "ยังไม่มีเลข QU" */
export function isAcceptableQuRef(raw: string | null | undefined): boolean {
  return isValidQuRef(raw) || isQuPending(raw)
}

/** ข้อความเตือนตอนใส่ค่าผิด — ใช้ถ้อยคำเดียวกันทุก endpoint */
export function quRefRejectMessage(raw: string | null | undefined): string {
  return (
    `Agency ref/Product Code ต้องเป็นเลขใบเสนอราคารูปแบบ QU (เช่น QU-4289) ` +
    `— ถ้ายังไม่มีเลข ใส่ "${QU_PENDING}" ไว้ก่อนได้ แล้วกลับมาแก้ทีหลัง ` +
    `— ค่าที่ส่งมา: "${raw ?? ''}"`
  )
}
