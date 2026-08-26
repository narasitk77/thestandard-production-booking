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

// ─────────────────────────────────────────────────────────────────────────────
// v1.200 — ฝั่ง "เขียน": จองห้องจริงในระบบกลาง
//
// สเปคจาก IT (เอกสาร Probook × TSD Room Booking Integration, 2026-08-25)
//   POST /api/liff/booking  · header `x-service-key`
//   body: roomId, startDate, startTime, endDate, endTime, title, name, email,
//         department, notes?   — **เวลาเป็นเวลาไทยตรง ๆ ไม่ใช่ UTC**
//         (คนละแบบกับ check-conflict ที่รับ ISO UTC — IT เตือนไว้เองในเอกสาร)
//   ตอบ 200: { success: true, bookingNo: "BK-0412" }
//
// ⚠️ **ข้อที่เปลี่ยนวิธีออกแบบทั้งหมด: ระบบเขาไม่มี idempotency — ยิงซ้ำ = จองซ้ำ**
// ฉะนั้นห้าม retry แบบเดิม ๆ เด็ดขาด เส้นทางที่ปลอดภัยคือ
//   1. ฝั่งเราจำ bookingNo ไว้ → มีแล้วไม่ยิงอีก
//   2. ถ้าผลลัพธ์ "ไม่รู้" (timeout/เน็ตหลุด) → **อ่านกลับก่อนเสมอ** ด้วย marker
//      `[PB-<bookingCode>]` ใน title แล้วค่อยตัดสินใจ ไม่ใช่ยิงใหม่
//
// อีกข้อที่อ่านผิดง่าย: **"ห้องถูกจองแล้ว" ตอบกลับมาเป็น 500 ไม่ใช่ 409**
// ถ้าเหมา 5xx = ชั่วคราวแล้ว retry จะกลายเป็นยิงซ้ำใส่ห้องที่เต็มอยู่แล้วไม่รู้จบ
// ─────────────────────────────────────────────────────────────────────────────

/** marker ที่ฝังใน title — ใช้ทั้ง trace ย้อนหลังและอ่านกลับมาจับคู่ */
export function roomBookingMarker(bookingCode: string): string {
  return `[PB-${bookingCode}]`
}

export function buildRoomBookingTitle(bookingCode: string, showName: string): string {
  return `${roomBookingMarker(bookingCode)} ${showName}`.trim()
}

export interface RoomBookingPayload {
  roomId: number
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  title: string
  name: string
  email: string
  department: string
  notes?: string
}

/**
 * ประกอบ body ให้ตรงสเปค — **เวลาไทยตรง ๆ ไม่แปลงเป็น UTC**
 * คืน null พร้อมเหตุผลเมื่อประกอบไม่ได้ ดีกว่าเดาค่าแล้วจองผิดเวลา
 */
export function buildRoomBookingPayload(input: {
  roomId: number
  bookingCode: string
  showName: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string | null
  producerName?: string | null
  producerEmail?: string | null
  department?: string | null
  notes?: string | null
}): { payload: RoomBookingPayload } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shootDate)) return { error: 'shootDate ไม่ใช่ YYYY-MM-DD' }
  if (!/^\d{2}:\d{2}$/.test(input.callTime)) return { error: 'callTime ไม่ใช่ HH:mm' }
  const email = (input.producerEmail || '').trim()
  // ระบบเขาปฏิเสธอีเมลนอกโดเมนพนักงาน (ตอบ 500) — กันไว้ก่อนยิงดีกว่าไปเจอปลายทาง
  if (!/^[^@\s]+@thestandard\.co$/i.test(email)) {
    return { error: `ต้องมีอีเมลโปรดิวเซอร์ @thestandard.co (ตอนนี้: ${email || 'ว่าง'})` }
  }
  const wrap = (input.estimatedWrap || '').trim()
  const endTime = /^\d{2}:\d{2}$/.test(wrap) ? wrap : addHours(input.callTime, 8)
  const sameDay = !input.shootEndDate || input.shootEndDate === input.shootDate
  // ถ่ายข้ามคืน: wrap **น้อยกว่า** call แปลว่าเลิกวันถัดไป
  // ต่างจาก ot-sync ที่ใช้ <= โดยตั้งใจ — wrap เท่ากับ call เป๊ะ (09:00→09:00) ที่นี่
  // จะกลายเป็นยึดห้องยาว 24 ชม. ซึ่งน่าจะเป็นการกรอกผิดมากกว่างานจริง จึงให้ตกไป
  // เป็น error ให้คนมาดู ดีกว่าไปล็อกห้องทั้งวันของคนอื่น
  const overnight = sameDay && endTime < input.callTime
  const endDate = input.shootEndDate || (overnight ? nextDay(input.shootDate) : input.shootDate)

  const spanDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${input.shootDate}T00:00:00Z`)) / 86_400_000)
  if (spanDays < 0) return { error: 'วันจบอยู่ก่อนวันเริ่ม' }
  if (spanDays > 10) return { error: 'ช่วงจองเกิน 10 วัน (กติกาของระบบกลาง)' }
  if (spanDays === 0 && endTime <= input.callTime) return { error: 'เวลาจบต้องหลังเวลาเริ่ม' }

  return {
    payload: {
      roomId: input.roomId,
      startDate: input.shootDate,
      startTime: input.callTime,
      endDate,
      endTime,
      title: buildRoomBookingTitle(input.bookingCode, input.showName),
      name: (input.producerName || '').trim() || email.split('@')[0],
      email,
      department: (input.department || '').trim() || 'Production',
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    },
  }
}

export type RoomBookingOutcome =
  // v1.206 — `id` คือเลขที่ endpoint ยกเลิกใช้ (คนละเลขกับ bookingNo) IT เพิ่มมาให้
  // ในคำตอบของ POST แล้ว เก็บไว้ตั้งแต่ตอนจองดีกว่าไปไล่หาทีหลัง
  | { kind: 'ok'; bookingNo: string; id: number | null }
  | { kind: 'conflict'; message: string }      // ห้องเต็ม — ห้าม retry
  | { kind: 'invalid'; message: string }       // ข้อมูลเราผิด — ห้าม retry จนกว่าจะแก้
  | { kind: 'unknown'; message: string }       // ไม่รู้ผล — **ต้องอ่านกลับก่อนตัดสินใจ**

/**
 * แปลงคำตอบของระบบกลางเป็นผลที่ตัดสินใจต่อได้
 *
 * แยก "ห้ามยิงซ้ำ" ออกจาก "ไม่รู้ผล" ให้ชัด เพราะระบบเขาไม่มี idempotency —
 * เดาผิดฝั่งไหนก็เจ็บ: เหมาว่าไม่รู้ผลแล้วยิงซ้ำ = จองซ้ำ, เหมาว่าสำเร็จ = ห้องไม่ถูกจอง
 */
export function classifyRoomBookingResponse(
  status: number,
  body: any,
): RoomBookingOutcome {
  const message = String(body?.error || body?.message || '').trim()
  if (status === 200 && body?.success && body?.bookingNo) {
    const id = Number(body.id)
    return { kind: 'ok', bookingNo: String(body.bookingNo), id: Number.isFinite(id) ? id : null }
  }
  if (status === 401) return { kind: 'invalid', message: message || 'service key ผิดหรือไม่ได้แนบ' }
  if (status === 400) return { kind: 'invalid', message: message || 'ข้อมูลไม่ผ่านการตรวจ' }
  // เขาใช้ 500 ทั้งกรณีห้องเต็มและอีเมลผิดโดเมน — ต้องอ่านข้อความ ไม่ใช่ดูแค่รหัส
  if (message.includes('ถูกจองในช่วงเวลาดังกล่าวแล้ว')) return { kind: 'conflict', message }
  if (message.includes('อีเมลพนักงาน')) return { kind: 'invalid', message }
  if (status === 200) return { kind: 'unknown', message: 'ตอบ 200 แต่ไม่มี bookingNo' }
  return { kind: 'unknown', message: message || `HTTP ${status}` }
}

/** เปิดใช้การจองห้องอัตโนมัติหรือยัง — ปิดไว้เป็นค่าเริ่มต้น */
export function roomBookingEnabled(): boolean {
  return process.env.ROOM_BOOKING_ENABLED?.trim() === '1'
}

/**
 * เปิดเฉพาะบางห้องได้ — `ROOM_BOOKING_ROOMS="15,1"` (ว่าง = ทุกห้องที่แมปไว้)
 * ใช้ตอนทยอยเปิด เริ่มจาก Studio 1/2 ซึ่งเป็นห้องที่ใช้จริงเกือบทั้งหมด
 */
export function roomBookingAllowed(roomId: number): boolean {
  const raw = process.env.ROOM_BOOKING_ROOMS?.trim()
  if (!raw) return true
  return raw.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite).includes(roomId)
}

/**
 * หาการจองของเราในระบบกลาง ด้วย marker ใน title
 *
 * ใช้ `bookings-calendar` (ไม่ใช่ `room-slots`) เพราะอันนี้คืน `bookingNo` มาด้วย
 * ซึ่งเป็นสิ่งที่เราต้องเก็บไว้กันยิงซ้ำ ส่วน room-slots คืนแค่ title/เวลา
 */
export async function findExistingRoomBooking(
  bookingCode: string,
  year: number,
  month: number,
): Promise<{ id: number | null; bookingNo: string; title: string } | null> {
  const data = await getJson(`/api/liff/bookings-calendar?year=${year}&month=${month}`)
  const rows: any[] = Array.isArray(data?.bookings) ? data.bookings : []
  const marker = roomBookingMarker(bookingCode)
  const hit = rows.find(r => String(r?.title || '').includes(marker))
  if (!hit) return null
  // `id` เป็นเลขที่ path ของ endpoint ยกเลิกใช้ ส่วน `bookingNo` (BK-####) ไว้ให้คนอ่าน
  const id = Number(hit.id)
  return {
    id: Number.isFinite(id) ? id : null,
    bookingNo: String(hit.bookingNo || ''),
    title: String(hit.title || ''),
  }
}

export type RoomCancelOutcome =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden'; message: string }   // service key ใช้กับ endpoint นี้ไม่ได้
  | { kind: 'unknown'; message: string }

/**
 * ยกเลิกการจองในระบบกลาง
 *
 * v1.200.2 — **ยังไม่รู้ว่า service key ใช้กับ endpoint นี้ได้ไหม** เอกสารของ IT
 * ระบุแค่ว่า `POST /booking` ต้องใช้คีย์ ไม่ได้พูดถึง cancel เลย
 * ถ้าได้ 401/403 กลับมา แปลว่าต้องให้ IT เปิดสิทธิ์เพิ่ม — แยกผลนั้นออกมาให้ชัด
 * (`forbidden`) จะได้ไม่ไปปนกับ error ชั่วคราวแล้วเข้าใจผิดว่าลองใหม่ได้
 */
export async function cancelRoomBooking(
  roomBookingId: number,
  opts: { timeoutMs?: number } = {},
): Promise<RoomCancelOutcome> {
  const key = process.env.ROOM_BOOKING_SERVICE_KEY?.trim()
  if (!key) return { kind: 'forbidden', message: 'ยังไม่ได้ตั้ง ROOM_BOOKING_SERVICE_KEY' }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await fetch(`${ROOM_BOOKING_BASE_URL}/api/liff/bookings/${roomBookingId}/cancel`, {
      method: 'PATCH',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': key,
        'User-Agent': 'probook/1.0 (+production-booking)',
      },
      body: JSON.stringify({}),
    })
    const body = await res.json().catch(() => ({}))
    const message = String(body?.error || body?.message || '').trim()
    if (res.ok) return { kind: 'ok' }
    if (res.status === 401 || res.status === 403) {
      return { kind: 'forbidden', message: message || `HTTP ${res.status} — คีย์อาจใช้กับ cancel ไม่ได้` }
    }
    if (res.status === 404) return { kind: 'not-found' }
    return { kind: 'unknown', message: message || `HTTP ${res.status}` }
  } catch (e: any) {
    return { kind: 'unknown', message: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * ยิงจองจริง — **เรียกได้ต่อเมื่อผู้เรียกเช็คแล้วว่ายังไม่มี roomBookingNo**
 * ไม่ retry เองเด็ดขาด: ผลลัพธ์ `unknown` เป็นหน้าที่ของผู้เรียกที่จะอ่านกลับก่อน
 */
export async function createRoomBooking(
  payload: RoomBookingPayload,
  opts: { timeoutMs?: number } = {},
): Promise<RoomBookingOutcome> {
  const key = process.env.ROOM_BOOKING_SERVICE_KEY?.trim()
  if (!key) return { kind: 'invalid', message: 'ยังไม่ได้ตั้ง ROOM_BOOKING_SERVICE_KEY' }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await fetch(`${ROOM_BOOKING_BASE_URL}/api/liff/booking`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': key,
        // Cloudflare ตอบ 403 "error code: 1010" ถ้าไม่มี User-Agent
        'User-Agent': 'probook/1.0 (+production-booking)',
      },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    return classifyRoomBookingResponse(res.status, body)
  } catch (e: any) {
    // timeout / เน็ตหลุด = **ไม่รู้ว่าเขาบันทึกไปแล้วหรือยัง** ห้ามสรุปว่าล้มเหลว
    return { kind: 'unknown', message: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) }
  } finally {
    clearTimeout(t)
  }
}
