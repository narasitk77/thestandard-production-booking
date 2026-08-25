import { LOCATIONS, findLocation } from './locations'

/**
 * แปลง `Booking.locationName` (ข้อความอิสระ) → `location.id` ที่เสถียร
 *
 * v1.195 — โปรบุ๊คเก็บสถานที่เป็น "ข้อความที่เรนเดอร์แล้ว" มาตลอด ทั้งที่ฟอร์มจอง
 * รู้ id อยู่แล้ว (BookingWizard บังคับเลือกจาก LOCATIONS แล้วทิ้ง id ตอนส่ง) และ
 * RoutinePlanner เป็นช่องพิมพ์อิสระล้วน ๆ ผลบนพรอด 2026-08-25: ห้องเดียวกันมีได้
 * หลายสะกด และค่าที่ใช้บ่อยที่สุดในระบบคือ **`สตูดิโอ 1` 129 ใบ** (มาจาก
 * RoutinePlanner 128 ใบ) มากกว่า `Studio 1 (TSD)` ที่มี 65 ใบเสียอีก
 *
 * ตัวนี้มีไว้ **backfill ของเก่า** เท่านั้น — ของใหม่ต้องส่ง `locationId` มาตรง ๆ
 *
 * **หลักการ: ไม่มั่นใจ = คืน null** (แปลว่า "ไม่ใช่ห้องในตึก") การเดาผิดแย่กว่า
 * การไม่เดา เพราะปลายทางคือการไปจองห้องจริงในระบบกลาง — แมปผิดห้อง = ไปยึดห้อง
 * ที่คนอื่นใช้อยู่
 */

/** ข้อความ→id ที่ยืนยันจากข้อมูลจริงบนพรอด (ตรวจ 2026-08-25) */
const ALIASES: Record<string, string> = {
  // Studio 1 — `สตูดิโอ 1` คือค่าที่พบมากที่สุดในทั้งระบบ (RoutinePlanner)
  'สตูดิโอ 1': 'tsd-studio-1',
  'สตูดิโอ1': 'tsd-studio-1',
  'สตู 1': 'tsd-studio-1',
  'สตู1': 'tsd-studio-1',
  'studio1': 'tsd-studio-1',

  'สตูดิโอ 2': 'tsd-studio-2',
  'สตูดิโอ2': 'tsd-studio-2',
  'สตู 2': 'tsd-studio-2',
  'สตู2': 'tsd-studio-2',
  'studio2': 'tsd-studio-2',

  // War Room — พบทั้ง "War Room", "war room ชั้น 4", "War Room ชั้น 4"
  'war room': 'tsd-a-war-4f',
  'war room ชั้น 4': 'tsd-a-war-4f',
  'warroom': 'tsd-a-war-4f',
  'ห้อง war room': 'tsd-a-war-4f',

  'ห้อง pod 1': 'tsd-a-pod1-5f',
  'pod 1': 'tsd-a-pod1-5f',
  'pod 2': 'tsd-a-pod2-5f',
  'pod 3': 'tsd-a-pod3-5f',
}

/**
 * ข้อความที่ **ห้ามแมป** แม้จะดูคล้ายชื่อห้อง — กันเคสอันตรายที่สุด:
 * "Studio 1 RCA" คือสตูดิโอที่ RCA ไม่ใช่ Studio 1 ในตึก TSD
 */
const NEVER_MATCH = [
  'rca',
]

function norm(raw: string): string {
  return raw
    .replace(/ /g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** ข้อความนี้เป็น "ยังไม่รู้สถานที่" ไม่ใช่ห้อง */
export function isPlaceholderLocation(raw: string | null | undefined): boolean {
  const n = norm(raw || '')
  if (n === '') return true
  return /^(tbc|tbd|-|n\/a|na)$/.test(n)
    || n.includes('รอรายละเอียด')
    || n.includes('อัพเดต')
    || n.includes('อัปเดต')
    || n.includes('รอลิ้ง')
    || n.includes('รอลิงก์')
}

export function resolveLocationId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const original = raw.trim()
  if (original === '') return null

  // รูปแบบที่ BookingWizard สร้างเอง: `${fullName} — ${ข้อความเพิ่มเติม}`
  // ลองทั้งข้อความเต็มและเฉพาะหัว เพราะส่วนขยายมักเป็นหมายเหตุ/ลิงก์แผนที่
  //
  // NOTE: ไม่เช็ค isPlaceholderLocation ตรงนี้ — ข้อความจริงอย่าง
  // "On Location — ออฟฟิศลูกค้า (รอลิ้งค์โลเคชั่น)" มีคำว่า "รอลิ้ง" อยู่ในหมายเหตุ
  // แต่หัวข้อความเป็นสถานที่จริง. ข้อความที่เป็น placeholder ล้วนจะไม่ตรงกับอะไร
  // อยู่แล้วจึงคืน null เองโดยธรรมชาติ
  const head = original.split(/\s+—\s+/)[0].trim()

  for (const cand of [original, head]) {
    if (!cand) continue
    // ชิ้นที่เป็นลิงก์ = ไม่ใช่ชื่อห้อง (ห้องในตึกไม่ต้องมีแผนที่)
    if (/https?:\/\//i.test(cand)) continue

    const exact = findLocation(cand)
    if (exact) return exact.id

    const n = norm(cand)
    if (NEVER_MATCH.some(bad => n.includes(bad))) return null
    if (ALIASES[n]) return ALIASES[n]

    // ชื่อห้องแบบไม่สนตัวพิมพ์ (findLocation จับคู่แบบตรงตัวพิมพ์เท่านั้น)
    const ci = LOCATIONS.find(l => norm(l.id) === n || norm(l.name) === n || norm(l.fullName) === n)
    if (ci) return ci.id
  }

  return null
}

/** ห้องในตึกที่จองในระบบกลางได้ (ไม่นับ EXTERNAL) */
export function isInHouseRoom(locationId: string | null | undefined): boolean {
  if (!locationId) return false
  const loc = LOCATIONS.find(l => l.id === locationId)
  return !!loc && loc.group !== 'EXTERNAL'
}
