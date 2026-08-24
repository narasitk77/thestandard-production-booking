import { prisma } from './db'
import { todayBangkokStr } from './bangkok-day'

/**
 * Cleanup OT records based on the 10-day archive policy:
 *
 * - Current month: editable
 * - Previous month: archive (read-only) — kept for 10 days into new month
 * - Older than that: deleted
 *
 * Runs lazily on each /api/ot fetch — no cron needed.
 */
/**
 * เดือนที่เก่าที่สุดที่ยังเก็บไว้ — ทุกอย่างที่ **เก่ากว่านี้** ถูกลบ ที่เหลือเก็บหมด
 * (รวมเดือนอนาคต ซึ่งเป็นที่อยู่ของร่าง OT ส่วนใหญ่ เพราะสร้างจากคิวถ่ายล่วงหน้า)
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อเทสกฏนี้ได้โดยไม่ต้องมี DB — v1.192 เพิ่งเสีย
 * ข้อมูลจริงเพราะกฏนี้ไม่เคยถูกเทส
 */
export function otCleanupCutoff(todayBangkok: string): string {
  const [year, month, day] = todayBangkok.split('-').map(Number)
  const currentMonth = `${year}-${String(month).padStart(2, '0')}`
  if (day > 10) return currentMonth
  const prevDate = new Date(Date.UTC(year, month - 2, 1)) // month is 1-based; -2 = previous month index
  return `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function cleanupOTRecords(): Promise<number> {
  // Bangkok-local date — the server runs UTC, so deriving "now" from new Date()
  // drifts a day (and the month) for the ~7h each morning that is still yesterday
  // in UTC. Use the same business-timezone source as the editable-month gate.
  const oldestKept = otCleanupCutoff(todayBangkokStr())

  // 1) Drop records OLDER than the keep window (10-day archive policy)
  //
  // v1.192 — เดิมเป็น `month: { notIn: keep }` ซึ่ง **ลบเดือนอนาคตไปด้วย** ทั้งที่
  // นโยบายที่เขียนไว้ข้างบนคือ "Older than that: deleted" เท่านั้น
  //
  // ผลที่เกิดจริง: ร่าง OT ถูกสร้างอัตโนมัติจากคิวถ่าย ซึ่ง**ส่วนใหญ่เป็นวันในอนาคต**
  // → ทุกครั้งที่มีใครเปิดหน้า /ot (cleanup รันแบบ lazy ที่ GET /api/ot) ร่างของ
  // เดือนถัดไปถูกลบทิ้งทั้งหมดเงียบ ๆ. เจอ 2026-08-24 ตอนเปิดหน้าเพื่อทดสอบเรื่องอื่น
  // แล้วร่างเดือน ก.ย. 33 ใบหายไปทันที — ซึ่งคือเดือนที่ pilot จะใช้พอดี
  //
  // เทียบสตริง 'YYYY-MM' ได้ตรง ๆ เพราะ zero-padded (2026-09 < 2026-10)
  const oldDel = await prisma.oTRecord.deleteMany({
    where: { month: { lt: oldestKept } },
  })

  // 2) Drop legacy pre-v1.15 records that lack the new task fields.
  //    Safe filter: missing both startTime AND justification (so we never delete
  //    a freshly-created record that just hasn't been opened yet).
  const legacyDel = await prisma.oTRecord.deleteMany({
    where: {
      AND: [
        { startTime: null },
        { justification: null },
      ],
    },
  })

  return oldDel.count + legacyDel.count
}

export function currentMonthYYYYMM(): string {
  // Bangkok month, not server-UTC month — otherwise OT entry/edit for "today" is
  // wrongly rejected as a closed month during the early-morning UTC/Bangkok gap.
  return todayBangkokStr().slice(0, 7)
}

export function isMonthEditable(month: string): boolean {
  return month === currentMonthYYYYMM()
}
