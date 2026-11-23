/**
 * "ใบจองนี้ควรขึ้นป้ายเรื่องห้องว่าอะไร" — กฎเดียว ใช้ทั้งการ์ดและหน้าใบจอง (v1.227)
 *
 * บริสุทธิ์ ไม่ import อะไรเลย เพื่อให้ client component เรียกได้โดยไม่ลาก
 * โค้ดฝั่ง server (fetch / LOCATIONS / prisma) ติดไปด้วย
 *
 * ## ทำไมต้องมี "ต้องจองห้องเอง"
 *
 * `ROOM_BOOKING_ROOMS` เปิดทีละห้อง ห้องที่ยังไม่เปิดจะถูกข้าม และก่อน v1.227
 * มันถูกข้าม **โดยไม่เขียนสถานะอะไรลง DB เลย** → `roomBookingStatus` เป็น null
 * → ไม่มีป้าย → โปรดิวเซอร์ที่จอง War Room เข้าใจว่าห้องถูกจองให้แล้วเหมือน Studio
 * เพราะไม่มีอะไรบอกว่าต่างกัน (4 ใบ CONFIRMED ที่ War Room ไม่มีห้องจองไว้เลย
 * ตอนตรวจ 2026-09-18) — คลาสบั๊กเดียวกับ "ข้ามแบบไม่บอก" ที่ไล่แก้มาทั้งสัปดาห์
 *
 * Lounge (2/F) ไม่มีอยู่ในระบบจองกลางเลย จึงถูกข้ามตลอดกาล — ป้ายนี้ทำให้
 * ความจริงข้อนั้นมองเห็นได้ แทนที่จะต้องไปรู้จากเอกสาร
 */

export type RoomBadgeTone = 'busy' | 'pending' | 'manual' | 'held'

export interface RoomBadge {
  tone: RoomBadgeTone
  label: string
  title: string
}

/** เหตุผลข้ามที่แปลว่า "ห้องนี้มีอยู่จริง แต่ระบบไม่จองให้ — คนต้องจองเอง" */
const MANUAL_SKIPS = new Set(['room-not-enabled', 'no-room-mapping'])

/**
 * 2026-11-23 — เหตุผลข้ามที่แปลว่า "ข้อมูลใบจองไม่พอจะจองห้อง" (= expectedTarget 'unknown' ของ reconciler)
 * งานสตูดิโอที่ตกตรงนี้ = ไม่มีห้อง และไม่มีอะไรจองให้จนกว่าคนจะแก้ใบ — กฎเดียวของป้าย / reconciler / resync
 */
export const UNRESOLVED_SKIPS: ReadonlySet<string> = new Set(['no-location', 'no-times', 'bad-times'])

/** เหตุผลข้อบนเป็นภาษาคน — ใช้ทั้งป้ายและข้อความเตือน ops */
export function unresolvedRoomText(reason: string, locationName?: string | null): string {
  if (reason === 'no-location') return `ชื่อสถานที่${locationName ? ` "${locationName}"` : ''} ไม่ตรงกับห้องในระบบ`
  if (reason === 'no-times') return 'ยังไม่มีเวลาเรียกกอง'
  return 'เวลาถ่ายประกอบเป็นช่วงที่ใช้ไม่ได้ (เลิกก่อนเริ่ม / ยาวเกิน 10 วัน)'
}

/**
 * เหตุผลข้ามที่ **ไม่ต้องขึ้นป้าย** — ไม่ใช่สถานการณ์เรื่องห้อง
 * (งานนอกตึก / ยังไม่เลือกสถานที่ / ยังไม่กรอกเวลา / ปิดฟีเจอร์)
 */
function skipReasonOf(error?: string | null): string | null {
  const m = /^skip:\s*(.+)$/.exec((error || '').trim())
  return m ? m[1].trim() : null
}

export function roomBadge(
  status?: string | null,
  error?: string | null,
  /** 2026-11-23 — งานสตูดิโอที่ข้อมูลไม่พอจองห้องต้องมีป้าย (งานนอกสถานที่ไม่มีห้องเป็นเรื่องปกติ) */
  shootType?: string | null,
): RoomBadge | null {
  if (status === 'CONFLICT') {
    return {
      tone: 'busy',
      label: '⚠ ห้องไม่ว่าง',
      title: `จองห้องในระบบส่วนกลางไม่ได้ — ห้องไม่ว่างช่วงเวลานี้${error ? `\n${error}` : ''}`,
    }
  }
  if (status === 'INVALID' || status === 'UNKNOWN') {
    return {
      tone: 'pending',
      label: 'ห้องยังไม่ได้จอง',
      title: `ระบบยังจองห้องส่วนกลางให้ไม่สำเร็จ${error ? `\n${error}` : ''}`,
    }
  }
  if (status === 'SKIPPED') {
    const reason = skipReasonOf(error)
    // v1.227 — คนของงานนี้จองห้องเองไว้แล้ว: ห้องได้จริง ไม่ใช่ปัญหา
    // ป้ายนี้จึงต้อง "สบายใจ" ไม่ใช่เตือนภัย — แต่ยังต้องมี เพราะไม่งั้น
    // ไม่มีใครรู้ว่าห้องนี้ระบบไม่ได้จองให้ ถ้าคนนั้นไปยกเลิกเองก็ไม่มีใครรู้อีก
    if (reason === 'manual-hold') {
      return {
        tone: 'held',
        label: 'ห้องจองเองไว้แล้ว',
        title: 'มีคนของงานนี้จองห้องไว้เองในระบบส่วนกลางแล้ว ครอบคลุมเวลาถ่ายทั้งช่วง'
          + ' — โปรบุ๊คจึงไม่จองซ้ำ (ถ้ายกเลิกอันนั้น ระบบจะจองให้ใหม่เองรอบถัดไป)',
      }
    }
    if (reason && MANUAL_SKIPS.has(reason)) {
      return {
        tone: 'manual',
        label: 'ต้องจองห้องเอง',
        title: reason === 'no-room-mapping'
          ? 'ห้องนี้ไม่มีในระบบจองส่วนกลาง — ต้องจองเองที่ hub.thestandard.co'
          : 'ระบบยังไม่จองห้องนี้ให้อัตโนมัติ — ต้องจองเองที่ hub.thestandard.co',
      }
    }
    // 2026-11-23 — TSS-SCI-261209-01: แก้สถานที่เป็นชื่อพิมพ์เอง → ห้องเดิมถูกคืน ใบไม่มีห้อง และการ์ดไม่มีป้ายอะไรเลย
    if (reason && UNRESOLVED_SKIPS.has(reason) && shootType === 'STUDIO') {
      return {
        tone: 'pending',
        label: 'ห้องยังไม่ได้จอง',
        title: `${unresolvedRoomText(reason)} — ระบบจองห้องให้ไม่ได้ แก้ใบจองให้เลือกห้องจากรายการ / กรอกเวลาให้ครบ`,
      }
    }
  }
  return null
}
