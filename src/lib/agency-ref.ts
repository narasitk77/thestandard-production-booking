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
 * Kill switch: AGENCY_REF_QU_RULE=0 ปิดกฏได้ทันทีจาก stack env (ไม่ต้อง deploy)
 * เผื่อกฏไปขวางงานจองหน้างานแบบไม่คาดคิด
 */
import { prisma } from './db'

export function quRuleEnabled(): boolean {
  return process.env.AGENCY_REF_QU_RULE?.trim() !== '0'
}

/** ตัดช่องว่าง + uppercase — "qu 4289" → "QU4289", " QU-4289 " → "QU-4289" */
export function normalizeQuRef(raw: string | null | undefined): string {
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '')
}

const QU_RE = /^QU-?\d+[A-Z0-9/-]*$/

export function isValidQuRef(raw: string | null | undefined): boolean {
  const n = normalizeQuRef(raw)
  return n !== '' && QU_RE.test(n)
}

/**
 * ดึงเลข QU จากคิวก่อนหน้าของโปรเจกต์เดียวกัน (ล่าสุดก่อน) — คืน null เมื่อ
 * ไม่มีคิวไหนของโปรเจกต์เคยมีเลขที่รูปแบบถูกต้อง
 */
export async function pullQuRefFromProject(projectId: string): Promise<string | null> {
  const rows = await prisma.booking.findMany({
    where: { projectId, deletedAt: null, agencyRef: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { agencyRef: true },
    take: 10,
  })
  for (const r of rows) {
    if (isValidQuRef(r.agencyRef)) return normalizeQuRef(r.agencyRef)
  }
  return null
}
