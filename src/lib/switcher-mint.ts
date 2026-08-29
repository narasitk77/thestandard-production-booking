/**
 * v1.211 — ออกเลข Production ID ให้งานไลฟ์ของสวิตเชอร์
 *
 * แยกจาก switcher-jobs.ts เพราะตัวนั้นเป็นตรรกะบริสุทธิ์ (เทสต์ import ได้โดย
 * ไม่ต้องมี Prisma) ส่วนไฟล์นี้แตะ DB
 *
 * ลอกวิธีมาจาก create-booking.ts ตรง ๆ รวมทั้ง advisory lock: การอ่าน-แล้ว-เขียน
 * โดยไม่ล็อกทำให้สองคนที่กดพร้อมกันคำนวณลำดับเดียวกัน แล้วคนหลังชน @unique
 * (เคสจริงที่ v1.146 ไปแก้ในฝั่ง booking) · ล็อกปลดเองตอน commit/rollback
 */
import { prisma } from './db'
import {
  buildSwitcherProductionId,
  nextSwitcherSequence,
  switcherIdPrefix,
  yymmddFromISODate,
} from './switcher-jobs'

type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/** คีย์ล็อกของสายเลข outlet+วัน — คนละสายกับ `booking-seq:` โดยตั้งใจ */
export function switcherSeqLockKey(outletCode: string, isoDate: string): string {
  return `switcher-seq:${outletCode.toUpperCase()}:${yymmddFromISODate(isoDate)}`
}

/**
 * จองเลขถัดไปของ outlet+วันนั้น **ต้องเรียกภายใน $transaction เท่านั้น**
 * (ล็อกเป็น xact lock — เรียกนอก transaction คือล็อกที่ปลดทันที = ไม่ได้ล็อกอะไร)
 *
 * นับจากสองแหล่ง:
 *   switcher_jobs — เลขของงานไลฟ์เอง **รวมแถวที่ soft-delete แล้ว** เพราะเลขที่
 *                   เคยออกไปห้ามถูกใช้ซ้ำ (คนอาจก็อปไปแปะในชีท/โฟลเดอร์แล้ว)
 *   episodes      — กันไว้เผื่อวันหนึ่งมีคนเพิ่มรายการรหัส 'LIV' ลง data.ts
 *                   ซึ่งจะทำให้สายเลขของงานถ่ายวิ่งมาทับ prefix เดียวกัน
 *                   ตอนนี้ query นี้คืนศูนย์แถวเสมอ และนั่นคือเรื่องที่ตั้งใจ
 */
export async function mintSwitcherProductionId(
  tx: Tx,
  outletCode: string,
  isoDate: string,
): Promise<string> {
  const prefix = switcherIdPrefix(outletCode, isoDate)
  const [jobs, episodes] = await Promise.all([
    tx.switcherJob.findMany({
      where: { productionId: { startsWith: prefix } },
      select: { productionId: true },
    }),
    tx.episode.findMany({
      where: { episodeId: { startsWith: prefix } },
      select: { episodeId: true },
    }),
  ])
  const seq = nextSwitcherSequence([
    ...jobs.map(j => j.productionId),
    ...episodes.map(e => e.episodeId),
  ])
  return buildSwitcherProductionId(outletCode, isoDate, seq)
}

/** `SELECT pg_advisory_xact_lock(...)` — $executeRaw เพราะฟังก์ชันคืน void */
export async function lockSwitcherSequence(tx: Tx, outletCode: string, isoDate: string): Promise<void> {
  const key = switcherSeqLockKey(outletCode, isoDate)
  await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}
