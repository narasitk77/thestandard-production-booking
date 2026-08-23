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
 * ตัวยึด "ยังไม่ทราบเลข QU"
 *
 * v1.183 เริ่มจาก "1234" · **v1.188 เปลี่ยนตัวที่ประกาศเป็น `QU-1234TBC`**
 * (คำสั่ง operator 2026-08-23) เพราะเป็นสิ่งที่ทีมคิดขึ้นเองและใช้กันอยู่แล้ว —
 * ประกาศสิ่งที่คนทำอยู่แล้วให้ถูกกฏ ดีกว่าบังคับให้จำค่าใหม่
 *
 * ค่าที่เก็บลง DB = ตามที่พิมพ์เสมอ (ไม่เขียนทับ) — ตัวจับข้างล่างทนความต่าง
 */
export const QU_PENDING = 'QU-1234TBC'

/**
 * ตัดทุกอย่างที่ไม่ใช่ตัวอักษร/ตัวเลขออก แล้ว uppercase — ใช้ **เฉพาะตอนจับ**
 * ไม่ใช่ตอนเก็บ: "qu 1234 tbc" · "QU-1234-TBC" · "qu.1234/tbc" → "QU1234TBC"
 */
function loose(raw: string | null | undefined): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * งานนี้ "ยังไม่ทราบเลข QU" — ใส่ตัวยึดไว้ก่อน ต้องกลับมาเติมเลขจริงทีหลัง
 *
 * v1.188 — operator สั่งว่า *"เวลาตรวจจับให้จับตามเงื่อนไข แต่ต้องเผื่อเวลาเขาใส่ผิดด้วย"*
 * ตัวจับจึงทนกว่าตัวที่ประกาศไว้มาก นับเป็นตัวยึดเมื่อ (หลังตัดขีด/ช่องว่าง/จุด):
 *
 *   1. มี "TBC" อยู่ที่ไหนก็ได้ — `QU-1234TBC`, `1234TBC`, `TBC`, `QU-4480TBC`,
 *      `qu 1234 tbc` ครอบคลุมทั้งของที่ทีมเคยคิดเองและการพิมพ์ผิดทุกแบบ
 *   2. เป็น `1234` หรือ `QU1234` — `1234` คือตัวยึดเดิมของ v1.183 (มีใช้จริงบน
 *      พรอดแล้ว) ส่วน `QU1234` คือการพิมพ์ตัวยึดใหม่แล้วตก TBC
 *
 * **การแลกที่รู้ตัว**: `QU-1234` อาจเป็นเลขใบเสนอราคาจริงในทางทฤษฎี v1.183 จึง
 * เคยกันไว้ แต่ตอนนี้ `QU-1234TBC` เป็นตัวยึดที่ประกาศแล้ว คนพิมพ์ `QU-1234`
 * จึงมีแนวโน้มเป็นการตก TBC มากกว่า — และเลขจริงในระบบอยู่ช่วง 2811–4480
 * ถ้าพลาดจับของจริง ผลคือมีคนถูกเตือนเกินหนึ่งครั้งแล้วแก้กลับ (เสียงรบกวน)
 * ส่วนถ้าพลาดไม่จับตัวยึด ผลคืองานไม่ถูกตั้งเบิกโดยไม่มีใครรู้ (เงียบและแพงกว่า)
 */
export function isQuPending(raw: string | null | undefined): boolean {
  const n = loose(raw)
  if (n === '') return false
  if (n.includes('TBC')) return true
  return n === '1234' || n === 'QU1234'
}

/** ผ่านการตรวจ = เป็นเลข QU จริง หรือเป็นตัวยึด "ยังไม่มีเลข QU" */
export function isAcceptableQuRef(raw: string | null | undefined): boolean {
  return isValidQuRef(raw) || isQuPending(raw)
}

/** ข้อความเตือนตอนใส่ค่าผิด — ใช้ถ้อยคำเดียวกันทุก endpoint */
export function quRefRejectMessage(raw: string | null | undefined): string {
  return (
    `Agency ref/Product Code ต้องเป็นเลขใบเสนอราคารูปแบบ QU (เช่น QU-4289) ` +
    `— ถ้ายังไม่ทราบเลข ใส่ "${QU_PENDING}" ไว้ก่อนได้ แล้วกลับมาแก้ทีหลัง ` +
    `— ค่าที่ส่งมา: "${raw ?? ''}"`
  )
}

/** ข้อความช่วยเหลือใต้ช่องกรอก — ใช้ที่เดียวกันทุกฟอร์ม */
export const QU_FIELD_HINT = `งาน Advertorial ต้องมีเลขใบเสนอราคา (QU) ทุกครั้ง — หากยังไม่ทราบ ให้ใส่ ${QU_PENDING} ไว้ก่อน แล้วกลับมาแก้เมื่อได้เลขจริง`
