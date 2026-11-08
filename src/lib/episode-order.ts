import type { Prisma } from '@prisma/client'

/**
 * ทำไมไฟล์นี้ถึงมีอยู่ (bug class 9 'one rule, N copies' + class 17)
 *
 * ทุก query ที่ดึง EP ของใบจองต้องเรียงด้วยค่านี้ — ห้ามเขียน `orderBy: { sequence: 'asc' }` เอง
 * sequence อย่างเดียวไม่ใช่ลำดับรวม: ใบหลายรายการที่ทุก EP เป็น sequence=1 ⇒ Postgres คืนลำดับใดก็ได้
 * ⇒ episodes[0] (ชื่องาน/ชื่อรายการ) สลับไปมาทุกรอบ ⇒ folder-integrity rename กล่องกลับไปกลับมาทุกชั่วโมง
 * (WLT-OTH-261113-01 8 ครั้งใน 16 วัน) และแต่ละหน้าที่เรียงเองก็โชว์ "EP แรก" คนละตัว
 *
 * episodeId ไม่ unique (EP เดียวถ่ายข้ามหลายใบได้) จึงต้องปิดท้ายด้วย id ให้เป็นลำดับรวมจริง
 */
export const EPISODE_ORDER: Prisma.EpisodeOrderByWithRelationInput[] = [
  { sequence: 'asc' },
  { episodeId: 'asc' },
  { id: 'asc' },
]
