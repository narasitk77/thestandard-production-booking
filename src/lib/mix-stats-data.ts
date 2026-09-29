// v1.249 — โหลดข้อมูลให้ตัวเลขผลงาน/ภาระรายคน (/api/mix/stats) และ export CSV (/api/mix/export) ใช้ชุดเดียวกัน
// สองหน้าที่อ่านคนละที่ = dashboard กับ CSV เล่าคนละเรื่อง (bug-classes: one rule, N copies)

import { prisma } from './db'
import { getSoundAccess } from './session'
import { canViewMixStats, type MixStatsJob } from './mix-stats'

// ponytail: โหลดงานมิกซ์ทุกแถว + ประวัติทั้งหมดแล้วคิดในหน่วยความจำ — ปีละหลักร้อยงาน ถ้าเกินหลักหมื่นแถว
// ค่อยกรองด้วย createdAt/endedAt ก่อนโหลด (ต้องเก็บงานที่เปิดค้างข้ามช่วงไว้ด้วย)
export async function loadMixStatsInput(): Promise<{ jobs: MixStatsJob[]; roster: { email: string; name: string | null }[] }> {
  const [jobs, roster] = await Promise.all([
    prisma.mixJob.findMany({
      include: { events: { orderBy: { at: 'asc' } } },
      orderBy: { number: 'asc' },
    }),
    prisma.teamMember.findMany({ where: { role: 'sound', active: true }, select: { email: true, name: true } }),
  ])
  return { jobs, roster }
}

/** สิทธิ์ดูผลงานรายคน — อ่าน role จริงจาก DB (ไม่เชื่อ token อย่างเดียว) */
export async function mixStatsAccess(email: string, role: string | null | undefined): Promise<boolean> {
  return canViewMixStats(await getSoundAccess(email, role))
}
