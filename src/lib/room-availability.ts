/**
 * "ห้องนี้ว่างไหม" — ตัวตอบคำถามเดียวที่ทั้งแอปใช้ร่วมกัน (v1.223)
 *
 * ## ทำไมถามฐานข้อมูลตัวเองเป็นหลัก ไม่ใช่ถามระบบจองห้องกลาง
 *
 * วัดจริงเมื่อ 2026-09-16: ทั้งเดือนกันยายน ระบบกลางมีการจอง 50 รายการ
 * **มาจากโปรบุ๊ค 49** และในห้องที่โปรบุ๊คจองให้จริง (Studio 1/2) คือ **66/66
 * เป็นของเราเองทั้งหมด แผนกอื่น 0** แปลว่าคำตอบที่ถูกต้องเกือบทั้งหมดอยู่ใน
 * ฐานข้อมูลของเราอยู่แล้ว และ:
 *
 *   - ตอบได้แม้ระบบของ IT ล่ม (เช้า 16 ก.ย. เขาล่มจริง ~10 นาที)
 *   - ตอบได้เร็ว ไม่กิน rate limit 20 req/5 นาที ที่ทั้งบริษัทใช้ร่วมกัน
 *   - **จับเคสที่ระบบเขาจับไม่ได้**: ใบที่เพิ่งจองคิวแต่ยังไม่ได้อนุมัติ ยังไม่มี
 *     แถวในระบบเขาเลย ถ้าถามเขาอย่างเดียวจะตอบว่า "ว่าง" ให้ห้องที่โปรดิวเซอร์
 *     อีกคนเพิ่งจองไปเมื่อกี้ — ซึ่งเป็นการชนกันแบบที่เกิดขึ้นจริงบ่อยที่สุด
 *     (17 ก.ย. Studio 1 มีสามใบซ้อนกันช่วง 16:00 ทั้งหมดเป็นงานของโปรบุ๊คเอง)
 *
 * ระบบกลางจึงเป็น **ชั้นเสริมที่ล้มได้เงียบ ๆ** สำหรับห้องที่แผนกอื่นใช้ร่วม
 * (ห้องประชุม/Pod/Hall) — อ่านจาก snapshot ที่แคชไว้ ไม่ใช่ยิงสดทุกครั้งที่พิมพ์
 * และถ้าอ่านไม่ได้ ต้องบอกว่า "ตรวจส่วนนี้ไม่ได้" ไม่ใช่กลืนเป็น "ว่าง"
 *
 * ## สามสถานะเท่านั้น — และไม่มีคำว่า "ว่าง"
 *
 * การตรวจตอนกรอกฟอร์มรับประกันอะไรไม่ได้เลย เพราะระหว่างที่คนกรอกอยู่ อีกคน
 * กดส่งตัดหน้าได้ คำว่า "ว่าง ✅" จึงเป็นคำโกหกเสมอ ที่พูดได้จริงคือ
 * **"ยังไม่มีใครจอง ณ เวลาที่ตรวจ"**
 */
import { prisma } from './db'
import { LOCATIONS } from './locations'
import { effectiveWrap, isValidHHMM, timeWindowsOverlap } from './shoot-window'
import { roomIdForLocation, listRoomBookings } from './room-booking'
// ชื่อใบจองมีกฎกลางอยู่แล้ว — เขียนเองได้ชื่อ *ประเภทเนื้อหา* ("Long-form · รายการ
// · ซีรีส์ · สัมภาษณ์ยาว") เพราะ program ระดับใบจองเป็น bucket ชื่อจริงอยู่ที่ตอน
import { bookingDisplayName } from './display'
// ฟอร์มแก้ไขเก็บ "ชื่อสถานที่" ไม่ใช่ id — แปลงด้วยตัวเดียวกับที่ create/PATCH ใช้
// ห้ามให้ฝั่งหน้าเว็บเดาเอง ไม่งั้นจะมีกฎแปลงชื่อ→ห้อง เกิดขึ้นเป็นตัวที่สอง
import { resolveLocationId } from './location-resolve'

/** สถานะของห้องที่ถามมา */
export type RoomAvailability =
  /** ไม่ใช่ห้องในตึก (นอกสถานที่ / ยังไม่ได้เลือก) — ไม่ต้องแสดงอะไร */
  | { state: 'not-a-room'; reason: string }
  /** ข้อมูลไม่พอจะตอบ (ยังไม่กรอกเวลา, เวลาพัง) — ไม่ใช่ "ว่าง" */
  | { state: 'unknown'; reason: string }
  /** มีคนจองคาบเกี่ยวอยู่ */
  | { state: 'busy'; window: string; conflicts: RoomConflictRow[]; externalChecked: boolean; externalError?: string }
  /** ตรวจแล้วยังไม่เจอใครจอง ณ เวลานี้ — **ไม่ใช่การรับประกันว่าว่าง** */
  | { state: 'no-conflict-known'; window: string; externalChecked: boolean; externalError?: string }

export interface RoomConflictRow {
  /** 'probook' = คิวถ่ายของเราเอง · 'other' = แผนกอื่นในระบบกลาง */
  source: 'probook' | 'other'
  /** ช่วงเวลาไทยที่อ่านออก เช่น "16:00–18:00" */
  time: string
  /** ชื่องาน — โชว์เฉพาะของโปรบุ๊คเอง ของแผนกอื่นตัดทิ้งที่ server */
  label: string
  /** Production ID ของใบที่ชน (เฉพาะของเรา) */
  code?: string
  /** true = ใช้เวลาเลิกโดยประมาณ (ไม่ได้กรอก wrap) */
  estimated?: boolean
}

export interface RoomAvailabilityInput {
  locationId?: string | null
  /** ใช้เมื่อผู้เรียกมีแต่ชื่อ (ฟอร์มแก้ไขของโปรดิวเซอร์) — แปลงที่ server */
  locationName?: string | null
  shootDate: string            // YYYY-MM-DD (เวลาไทย)
  shootEndDate?: string | null
  callTime?: string | null     // HH:MM
  estimatedWrap?: string | null
  /** ตอนแก้ใบเดิม ต้องไม่บอกว่าชนกับตัวเอง */
  excludeBookingId?: string | null
}

/** สถานะคิวที่ยัง "จะถ่ายจริง" — ยกเลิก/จบแล้วคืนห้อง (ชุดเดียวกับ booking-overlap) */
const LIVE_STATUSES = ['REQUESTED', 'ASSIGNED', 'CONFIRMED'] as const

/**
 * แคช snapshot ของระบบกลางราย "ปี-เดือน"
 *
 * ต่ออายุตามเวลา **ไม่ใช่ตามการพิมพ์ของผู้ใช้** — ไม่งั้นโปรดิวเซอร์ที่เปลี่ยนวัน
 * ไปมาไม่กี่คนจะกินโควตา 20 req/5 นาที จนงานจองจริงของ worker ยิงไม่ออก
 * (ทุก request ออกจาก IP เดียวกันหมด)
 */
const EXTERNAL_TTL_MS = 5 * 60 * 1000
type ExternalEntry = { at: number; rows: Awaited<ReturnType<typeof listRoomBookings>> | null; error?: string }
const externalCache = new Map<string, ExternalEntry>()

async function externalMonth(year: number, month: number): Promise<ExternalEntry> {
  const key = `${year}-${month}`
  const hit = externalCache.get(key)
  if (hit && Date.now() - hit.at < EXTERNAL_TTL_MS) return hit
  try {
    const rows = await listRoomBookings(year, month)
    const entry = { at: Date.now(), rows }
    externalCache.set(key, entry)
    return entry
  } catch (e: any) {
    // อ่านไม่ได้ ≠ ว่าง — เก็บ error ไว้บอกผู้ใช้ตรง ๆ และแคชสั้น ๆ กันยิงรัว
    const entry: ExternalEntry = { at: Date.now(), rows: null, error: e?.message || String(e) }
    externalCache.set(key, entry)
    return entry
  }
}

/** ล้างแคช — สำหรับเทสเท่านั้น */
export function __clearRoomAvailabilityCache() {
  externalCache.clear()
}

const hhmm = (d: Date) => {
  const bkk = new Date(d.getTime() + 7 * 3_600_000)
  return `${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`
}

export async function checkRoomAvailability(input: RoomAvailabilityInput): Promise<RoomAvailability> {
  const locationId = (input.locationId || '').trim() || (resolveLocationId(input.locationName || '') || '')
  if (!locationId) {
    // มีชื่อแต่แปลงเป็นห้องไม่ได้ = นอกตึก หรือชื่อที่ระบบไม่รู้จัก — อย่างไรก็ตรวจให้ไม่ได้
    return { state: 'not-a-room', reason: (input.locationName || '').trim() ? 'สถานที่นี้ไม่ใช่ห้องในตึก' : 'ยังไม่ได้เลือกสถานที่' }
  }

  const loc = LOCATIONS.find(l => l.id === locationId)
  if (!loc || loc.group === 'EXTERNAL') return { state: 'not-a-room', reason: 'งานนอกตึก ไม่ต้องจองห้อง' }

  const callTime = (input.callTime || '').trim()
  if (!isValidHHMM(callTime)) return { state: 'unknown', reason: 'ยังไม่ได้กรอกเวลาเรียกกอง' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shootDate)) return { state: 'unknown', reason: 'วันถ่ายไม่ถูกต้อง' }

  const wrapRaw = (input.estimatedWrap || '').trim()
  const wrap = effectiveWrap(callTime, isValidHHMM(wrapRaw) ? wrapRaw : null)
  // เวลาเลิกที่มาก่อนเวลาเริ่มในวันเดียวกัน = กรอกผิด หรือกองข้ามคืน — ตัวเลขที่ได้
  // เทียบช่วงเวลาไม่ได้ ต้องบอกว่าตรวจไม่ได้ ไม่ใช่เงียบแล้วปล่อยผ่านเป็น "ว่าง"
  const sameDay = !input.shootEndDate || input.shootEndDate === input.shootDate
  if (sameDay && wrap.end <= callTime) {
    return { state: 'unknown', reason: 'เวลาเลิกไม่ได้อยู่หลังเวลาเรียกกอง — ตรวจให้ไม่ได้' }
  }
  const windowLabel = `${callTime}–${wrap.end}${wrap.estimated ? ' (ประมาณ)' : ''}`

  const start = new Date(`${input.shootDate}T00:00:00.000Z`)
  const end = input.shootEndDate ? new Date(`${input.shootEndDate}T00:00:00.000Z`) : start

  // ── ชั้นที่ 1: ฐานข้อมูลของเราเอง (ตัวหลัก) ────────────────────────────
  const rows = await prisma.booking.findMany({
    where: {
      locationId,
      status: { in: [...LIVE_STATUSES] },
      deletedAt: null,
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
      // ช่วงวันคาบเกี่ยวกัน (กรองหยาบใน SQL แล้วค่อยเทียบเวลาใน JS
      //  เพราะ callTime เก็บเป็นสตริง HH:MM เทียบใน Prisma WHERE ไม่ได้)
      shootDate: { lte: end },
      OR: [
        { shootEndDate: null, shootDate: { gte: start } },
        { shootEndDate: { gte: start } },
      ],
    },
    select: {
      bookingCode: true, callTime: true, estimatedWrap: true,
      shootDate: true, shootEndDate: true, projectName: true,
      program: { select: { name: true } },
      outlet: { select: { code: true } },
      episodes: {
        orderBy: { sequence: 'asc' as const },
        select: { title: true, program: { select: { name: true } } },
      },
    },
    orderBy: { callTime: 'asc' },
    take: 50,
  })

  const conflicts: RoomConflictRow[] = []
  for (const r of rows) {
    const theirs = effectiveWrap(r.callTime, isValidHHMM(r.estimatedWrap || '') ? r.estimatedWrap : null)
    // งานหลายวัน: วันที่ไม่ใช่วันแรก/วันสุดท้ายถือว่ากินทั้งวัน (เหมือน resource-load)
    const multiDay = !!r.shootEndDate && r.shootEndDate.getTime() > r.shootDate.getTime()
    const hit = multiDay
      ? true
      : timeWindowsOverlap(callTime, wrap.end, r.callTime, theirs.end)
    if (!hit) continue
    conflicts.push({
      source: 'probook',
      time: multiDay ? 'ทั้งวัน (งานหลายวัน)' : `${r.callTime}–${theirs.end}${theirs.estimated ? ' (ประมาณ)' : ''}`,
      label: [r.outlet?.code, bookingDisplayName(r)].filter(Boolean).join(' · ') || 'งานถ่าย',
      code: r.bookingCode || undefined,
      estimated: theirs.estimated,
    })
  }

  // ── ชั้นที่ 2: ระบบกลาง เฉพาะ "ของแผนกอื่น" (เสริม ล้มได้) ─────────────
  // ของโปรบุ๊คเองในระบบเขาคือเงาของแถวที่นับไปแล้วในชั้นที่ 1 — นับซ้ำไม่ได้
  let externalChecked = false
  let externalError: string | undefined
  const roomId = roomIdForLocation(locationId)
  if (roomId !== null) {
    // v1.223.4 — งานที่ข้ามเดือน (เช่น 30 ก.ย.–2 ต.ค.) ต้องดู snapshot ของ
    // **ทุกเดือนที่ช่วงถ่ายพาดผ่าน** เดิมดึงเฉพาะเดือนของ shootDate จึงมองไม่เห็น
    // การจองของแผนกอื่นในเดือนถัดไปเลย แล้วรายงานว่า "ตรวจครบแล้ว"
    const months = new Set<string>()
    for (const d of [input.shootDate, input.shootEndDate || input.shootDate]) {
      const [yy, mm] = d.split('-').map(Number)
      if (Number.isFinite(yy) && Number.isFinite(mm)) months.add(`${yy}-${mm}`)
    }
    const entries = await Promise.all([...months].map(k => {
      const [yy, mm] = k.split('-').map(Number)
      return externalMonth(yy, mm)
    }))
    const ext = {
      rows: entries.every(e => e.rows) ? entries.flatMap(e => e.rows!) : null,
      error: entries.find(e => e.error)?.error,
    }
    if (ext.rows) {
      externalChecked = true
      const dayStart = Date.parse(`${input.shootDate}T00:00:00+07:00`)
      const dayEnd = Date.parse(`${input.shootEndDate || input.shootDate}T23:59:59+07:00`)
      const mineStart = Date.parse(`${input.shootDate}T${callTime}:00+07:00`)
      const mineEnd = Date.parse(`${input.shootEndDate || input.shootDate}T${wrap.end}:00+07:00`)
      for (const r of ext.rows) {
        if (r.roomId !== roomId) continue
        if (r.isProbook) continue          // เงาของเราเอง — นับไปแล้วชั้นที่ 1
        if (!r.startAt || !r.endAt) continue
        const s = Date.parse(r.startAt), e = Date.parse(r.endAt)
        if (Number.isNaN(s) || Number.isNaN(e)) continue
        if (e <= dayStart || s >= dayEnd) continue
        if (!(mineStart < e && s < mineEnd)) continue
        conflicts.push({
          source: 'other',
          time: `${hhmm(new Date(s))}–${hhmm(new Date(e))}`,
          // **ตัดหัวข้อประชุมของแผนกอื่นทิ้งที่นี่ ไม่ใช่ซ่อนที่หน้าเว็บ** —
          // ฟีดของเขาแถม title/email/department มาครบ ถ้าส่งออกไปก็คือเปิด
          // หัวข้อประชุมของ HR/People ให้โปรดิวเซอร์อ่าน
          label: 'แผนกอื่นจองไว้',
        })
      }
    } else {
      externalError = ext.error
    }
  }

  conflicts.sort((a, b) => a.time.localeCompare(b.time))
  return conflicts.length
    ? { state: 'busy', window: windowLabel, conflicts, externalChecked, externalError }
    : { state: 'no-conflict-known', window: windowLabel, externalChecked, externalError }
}
