import { LOCATIONS } from './locations'

/**
 * เชื่อมกับระบบจองห้องกลาง `service.thestandard.co/booking` — **เฉพาะฝั่งอ่าน**
 *
 * v1.195 (เฟส 2 ของ docs/room-booking-integration-plan.md) — ยังไม่จองจริง
 * เพราะ `POST /api/liff/booking` ต้องมี credential จาก IT. แต่ endpoint ฝั่งอ่าน
 * **เปิดหมดโดยไม่ต้อง auth** (ยืนยัน 2026-08-25) จึงทำส่วนตรวจห้องว่างได้เลย
 *
 * ⚠️ กับดักที่ต้องรู้ — `check-conflict` รับ `startAt`/`endAt` เป็น **UTC ISO**
 * ไม่ใช่ `startDate`+`startTime` และถ้าส่งพารามิเตอร์ผิด **มันตอบ `null`
 * ซึ่งแปลว่า "ว่าง"** ไม่ได้ตอบ error → เขียนผิดแบบเงียบ ๆ ได้ง่ายมาก
 * ทดสอบจริงกับช่องที่มีคนจองอยู่ (ห้อง 2 · 27 ส.ค. 13:00–14:00 BKK):
 *   startDate=…&startTime=13:00        → null                    ❌
 *   startAt=…T06:00:00.000Z&endAt=…    → {…"Digital Vaultwarden"} ✅
 */

export const ROOM_BOOKING_BASE_URL =
  process.env.ROOM_BOOKING_BASE_URL || 'https://service.thestandard.co'

/**
 * probook `location.id` → `roomId` ของระบบจองกลาง
 * **แมปด้วย id เท่านั้น ห้ามแมปด้วยชื่อ** (ชื่อคนละแบบ: B-1 ↔ "1", Hall ↔ "Hall A")
 * ห้องที่ไม่มีคู่ = ไม่ใส่ในตารางนี้ → ข้ามการจอง ไม่ใช่เดา
 */
export const LOCATION_TO_ROOM_ID: Record<string, number> = {
  'tsd-studio-1': 15,
  'tsd-studio-2': 1,
  'tsd-a-hall-1f': 6,
  'tsd-a-mr1-5f': 9,
  'tsd-a-mr2-4f': 8,
  'tsd-a-mr3-3f': 7,
  'tsd-a-pod1-5f': 12,
  'tsd-a-pod2-5f': 13,
  'tsd-a-pod3-5f': 14,
  'tsd-a-war-4f': 2,
  'tsd-b-1-5f': 17,
  'tsd-b-2-5f': 18,
  'tsd-b-3-5f': 19,
  'tsd-b-hall-5f': 20,
  // 'tsd-a-lounge-2f' — โปรบุ๊คมี Lounge (2/F) แต่ระบบจองกลางไม่มีห้องนี้ → ข้ามเสมอ
}

export function roomIdForLocation(locationId: string | null | undefined): number | null {
  if (!locationId) return null
  return LOCATION_TO_ROOM_ID[locationId] ?? null
}

/** เหตุผลที่ข้ามการจองห้อง — ต้องบอกได้เสมอว่าทำไมไม่จอง ไม่ใช่เงียบ */
export type RoomSkipReason =
  | 'no-location'        // ยังไม่ได้เลือกสถานที่
  | 'external'           // นอกตึก
  | 'no-room-mapping'    // ห้องในตึกแต่ระบบกลางไม่มี (Lounge)
  | 'no-times'           // ไม่มี callTime/estimatedWrap

export interface RoomTarget {
  roomId: number
  startAt: string   // UTC ISO
  endAt: string     // UTC ISO
}

/**
 * เวลาไทยของโปรบุ๊ค (`YYYY-MM-DD` + `HH:MM` เวลา Bangkok) → UTC ISO ที่ API เขารับ
 * Bangkok = UTC+7 ตลอดปี ไม่มี DST จึงลบ 7 ชั่วโมงตรง ๆ ได้
 */
export function bangkokToUtcIso(dateYMD: string, timeHHMM: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYMD) || !/^\d{2}:\d{2}$/.test(timeHHMM)) return null
  const ms = Date.parse(`${dateYMD}T${timeHHMM}:00+07:00`)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

export function roomTargetForBooking(input: {
  locationId: string | null | undefined
  shootDate: string          // YYYY-MM-DD (Bangkok)
  shootEndDate?: string | null
  callTime: string | null | undefined
  estimatedWrap?: string | null
}): { target: RoomTarget } | { skip: RoomSkipReason } {
  if (!input.locationId) return { skip: 'no-location' }
  const loc = LOCATIONS.find(l => l.id === input.locationId)
  if (!loc || loc.group === 'EXTERNAL') return { skip: 'external' }
  const roomId = roomIdForLocation(input.locationId)
  if (roomId === null) return { skip: 'no-room-mapping' }
  if (!input.callTime) return { skip: 'no-times' }

  const endTime = input.estimatedWrap || addHours(input.callTime, 4)
  const startAt = bangkokToUtcIso(input.shootDate, input.callTime)
  // ถ่ายข้ามวัน: ถ้า wrap <= call แปลว่าเลิกวันถัดไป (กฎเดียวกับ ot-sync)
  const endsNextDay = !input.shootEndDate && endTime <= input.callTime
  const endDate = input.shootEndDate || (endsNextDay ? nextDay(input.shootDate) : input.shootDate)
  const endAt = bangkokToUtcIso(endDate, endTime)
  if (!startAt || !endAt) return { skip: 'no-times' }
  return { target: { roomId, startAt, endAt } }
}

export interface RoomConflict {
  startAt: string
  endAt: string
  title?: string
  displayName?: string
}

async function getJson(path: string, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${ROOM_BOOKING_BASE_URL}${path}`, {
      signal: ctrl.signal,
      headers: {
        // Cloudflare ตอบ 403 "error code: 1010" ถ้าไม่มี User-Agent
        'User-Agent': 'probook/1.0 (+production-booking)',
        Accept: 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/** ช่วงที่ห้องถูกจองแล้วในวันนั้น (เวลาเป็น UTC ISO) */
export async function roomBusySlots(roomId: number, dateYMD: string): Promise<RoomConflict[]> {
  const data = await getJson(`/api/liff/room-slots?roomId=${roomId}&date=${encodeURIComponent(dateYMD)}`)
  return Array.isArray(data) ? data : []
}

/**
 * ตรวจว่าช่วงเวลานี้ชนกับการจองเดิมไหม — คืนการจองที่ชน หรือ null ถ้าว่าง
 *
 * ใช้ `room-slots` เป็นตัวตัดสิน **ไม่ใช้ `check-conflict`** เพราะ `check-conflict`
 * คืน `null` ทั้งตอน "ว่างจริง" และตอน "พารามิเตอร์ผิด" ซึ่งแยกกันไม่ออกจากฝั่งเรา
 * — ความกำกวมแบบนี้ในเส้นทางที่ตัดสินว่า "จองทับได้หรือไม่" คือความเสี่ยงที่ไม่คุ้ม
 */
export async function findRoomConflict(t: RoomTarget): Promise<RoomConflict | null> {
  const dates = utcRangeToBangkokDates(t.startAt, t.endAt)
  const seen = new Set<string>()
  for (const d of dates) {
    for (const slot of await roomBusySlots(t.roomId, d)) {
      const key = `${slot.startAt}|${slot.endAt}`
      if (seen.has(key)) continue
      seen.add(key)
      if (overlaps(t.startAt, t.endAt, slot.startAt, slot.endAt)) return slot
    }
  }
  return null
}

/** ช่วงเวลาสองช่วงทับกันไหม (ปลายชนปลายแบบ 10:00–11:00 กับ 11:00–12:00 = ไม่ทับ) */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd)
}

/** วันที่ (เวลาไทย) ที่ช่วง UTC นี้พาดผ่าน — ใช้ถามช่องว่างให้ครบทุกวัน */
export function utcRangeToBangkokDates(startAt: string, endAt: string): string[] {
  const out: string[] = []
  const DAY = 86_400_000
  let cur = Date.parse(startAt)
  const end = Date.parse(endAt)
  if (Number.isNaN(cur) || Number.isNaN(end)) return out
  while (cur <= end) {
    const d = new Date(cur + 7 * 3_600_000).toISOString().slice(0, 10)
    if (!out.includes(d)) out.push(d)
    cur += DAY
  }
  const last = new Date(end + 7 * 3_600_000).toISOString().slice(0, 10)
  if (!out.includes(last)) out.push(last)
  return out
}

function addHours(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = Math.min(23 * 60 + 59, h * 60 + m + hours * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function nextDay(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}
