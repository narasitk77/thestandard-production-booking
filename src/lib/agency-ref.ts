/**
 * v1.161 — กฏ Agency ref: งาน Agency (Advertorial) ต้องมีเลขใบเสนอราคารูปแบบ QU
 *
 * v1.183 — ตัว predicate ย้ายไป ./qu-ref (ไม่ import prisma) เพื่อให้ฝั่งฟอร์มจอง
 * ใช้กฏชุดเดียวกันได้; ไฟล์นี้เหลือส่วนที่แตะ DB + re-export ของเดิมไว้ครบ
 * (import จาก '@/lib/agency-ref' เหมือนเดิมได้ทุกที่)
 */
import { prisma } from './db'
import { isValidQuRef, normalizeQuRef } from './qu-ref'

export {
  quRuleEnabled,
  normalizeQuRef,
  isValidQuRef,
  isQuPending,
  isAcceptableQuRef,
  quRefRejectMessage,
  QU_PENDING,
} from './qu-ref'

/**
 * ดึงเลข QU จากคิวก่อนหน้าของโปรเจกต์เดียวกัน (ล่าสุดก่อน) — คืน null เมื่อ
 * ไม่มีคิวไหนของโปรเจกต์เคยมีเลขที่รูปแบบถูกต้อง
 *
 * ใช้ isValidQuRef (ไม่ใช่ isAcceptableQuRef) โดยตั้งใจ: ตัวยึด "1234" ของคิว
 * ก่อนหน้าต้องไม่ถูกดึงมาใส่คิวใหม่ ไม่งั้น placeholder จะแพร่ไปทั้งโปรเจกต์
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
