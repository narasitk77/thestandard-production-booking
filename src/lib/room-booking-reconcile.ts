import { prisma } from './db'
import { logAudit } from './audit'
import { notifyChat } from './notify'
import {
  findExistingRoomBooking, cancelRoomBooking, roomIdForLocation,
  roomTargetForBooking, roomBookingEnabled, roomBookingAllowed, listRoomBookings,
  findManualHold, bangkokToUtcIso, roomBookingMarker,
} from './room-booking'
import { syncRoomBooking, buildPayloadForBooking, ROOM_BOOKING_SELECT } from './room-booking-sync'

/**
 * ตัวคืนสภาพการจองห้อง — ทำให้ระบบกลางตรงกับคิวถ่ายของเรา
 *
 * v1.204 (operator 2026-08-25: *"มึงต้องเป็นคนทำเองไม่ใช่มาแจ้งให้กูไปทำ
 * ทำ worker สำหรับเรื่องนี้มาเลย"*)
 *
 * เดิมเวลาคืนห้องไม่สำเร็จ เราแค่เขียน audit แล้วจบ — ซึ่งไม่มีใครเปิดอ่าน
 * ห้องเลยถูกยึดค้างไว้โดยไม่มีใครรู้ ตัวนี้ทำงานเป็นรอบและ **ลงมือแก้เอง**
 *
 * สามอย่างที่มันตามเก็บ:
 *   1. **ห้องค้าง** — คิวยกเลิก/ถูกลบไปแล้ว แต่ห้องในระบบเขายังถูกจองอยู่ → สั่งยกเลิก
 *   2. **ห้องผิด** — คิวย้ายห้อง/ย้ายเวลาหลังจองไปแล้ว → ยกเลิกของเดิม (แล้วจองใหม่
 *      ในรอบถัดไปถ้าเปิดจองอัตโนมัติไว้)
 *   3. **ยังไม่ได้จอง** — คิวที่ควรมีห้องแต่ยังไม่มี (รอบก่อนล้ม/ไม่รู้ผล) → จองให้
 *
 * ทำไมต้องมีแม้ยกเลิกยังไม่ได้: ตอนนี้ `x-service-key` ยังไม่มีสิทธิ์ยกเลิก
 * (ยืนยันแล้ว 2026-08-25 — ได้ 401) แต่พอ IT เปิดสิทธิ์ให้เมื่อไร **ห้องที่ค้างอยู่
 * จะถูกเก็บกวาดเองในรอบถัดไป โดยไม่ต้องมีใครจำว่ามีอะไรค้าง** และระหว่างที่ยัง
 * ยกเลิกไม่ได้ มันจะเตือนเข้า Discord พร้อมเลข BK-#### ที่ต้องไปปลดมือ
 *
 * ข้อบังคับที่สืบทอดมา: ระบบเขาไม่มี idempotency → ทุกการ "จอง" ต้องผ่าน
 * syncRoomBooking ซึ่งอ่านกลับก่อนยิงเสมอ (ห้ามยิงตรง)
 */

/**
 * ใบที่ได้ CONFLICT ("ห้องไม่ว่าง") รอเท่านี้ก่อนลองใหม่
 *
 * v1.222 — ห้องเต็มไม่ใช่ error ชั่วคราว การยิงซ้ำทุกชั่วโมงจึงเป็นการเผาโควตา
 * 20 req/5 นาที ที่ทั้งบริษัทใช้ร่วมกัน ทับใบที่จองได้จริง และเด้งเข้ากลุ่ม LINE
 * ของแอดมิน IT ทุกรอบ. ยังลองใหม่อยู่ เผื่อคนที่จองทับไว้ยกเลิก — แค่ห่างขึ้น
 */
const CONFLICT_RETRY_MS = 6 * 60 * 60 * 1000

export interface RoomReconcileResult {
  scanned: number
  staleCancelled: string[]     // ห้องค้างที่ยกเลิกสำเร็จ
  staleStuck: { code: string; bookingNo: string | null; reason: string }[]  // ยกเลิกไม่ได้/ยังจองไม่ได้ ต้องมือ
  wrongRoomReleased: string[]  // ห้อง/เวลาไม่ตรง ปลดของเดิมแล้ว
  vanished: string[]           // เราคิดว่าจองไว้ แต่หายไปจากระบบเขาแล้ว
  /** v1.227 — ห้องที่ระบบยังไม่จองให้อัตโนมัติ (ROOM_BOOKING_ROOMS) — ต้องจองเอง */
  notEnabled: string[]
  booked: { code: string; bookingNo: string }[]
  failed: { code: string; status: string; message?: string }[]
  dryRun: boolean
}

/**
 * ห้องที่ควรถูกยึดไว้ให้คิวนี้ตอนนี้ — **สามสถานะ ไม่ใช่สอง**
 *
 * v1.222 review fix — เดิมคืน null ก้อนเดียวสำหรับ skip ทุกเหตุผล แล้วผู้เรียก
 * แปล null = "ไม่ควรมีห้อง" ⇒ **สั่งยกเลิกห้อง** ซึ่งเหมาเอา "บอกไม่ได้" ไปรวมกับ
 * "ไม่ควรมีห้อง": ใบที่เวลาพัง (bad-times), ยังไม่กรอกเวลา, หรือแปลง locationId
 * ไม่ได้ จะถูกปลดห้องทิ้งทั้งที่กองมีอยู่จริงและกำลังจะถ่าย
 *
 * แยกเป็น:
 *   - `none`    ยกเลิก/ถูกลบ, ออกนอกตึก, ห้องที่ระบบกลางไม่มี → ปลดห้องได้ ถูกต้อง
 *   - `unknown` ข้อมูลไม่พอจะตัดสิน → **ห้ามแตะห้อง** รายงานให้คนดูแทน
 *   - `target`  รู้ชัดว่าควรเป็นห้องไหน ช่วงไหน
 */
type Expected =
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'target'; target: { roomId: number; startAt: string; endAt: string } }

function expectedTarget(b: any): Expected {
  if (b.deletedAt || b.status === 'CANCELLED') return { kind: 'none' }
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const t = roomTargetForBooking({
    locationId: b.locationId,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap,
  })
  if (!('skip' in t)) return { kind: 'target', target: t.target }
  // งานนอกตึก / ห้องที่ระบบกลางไม่มี = ไม่ควรมีห้องจริง ๆ ปลดได้
  if (t.skip === 'external' || t.skip === 'no-room-mapping') return { kind: 'none' }
  // ที่เหลือ (no-location / no-times / bad-times) = ข้อมูลไม่พอ ไม่ใช่คำตอบว่า "ไม่เอาห้อง"
  return { kind: 'unknown', reason: t.skip }
}

/** เขียนสถานะ "ข้าม" ลง DB — ข้ามเงียบคือคลาสบั๊กที่เราไล่แก้มาทั้งชุด */
async function stampSkipped(id: string, reason: string) {
  await prisma.booking.update({
    where: { id },
    data: { roomBookingStatus: 'SKIPPED', roomBookingError: `skip: ${reason}`, roomBookingAt: new Date() },
  })
}

export async function reconcileRoomBookings(opts: {
  dryRun?: boolean
  days?: number
  max?: number
} = {}): Promise<RoomReconcileResult> {
  const dryRun = opts.dryRun !== false
  const days = Math.min(120, Math.max(1, opts.days ?? 45))
  const max = Math.min(20, Math.max(1, opts.max ?? 8))

  const today = new Date()
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const to = new Date(from.getTime() + days * 86_400_000)

  // ครอบทั้งใบที่ยังมีชีวิตและใบที่ตายแล้วแต่ยังจำเลขห้องไว้ — ใบที่ตายแล้วคือ
  // ต้นตอของ "ห้องค้าง" ซึ่งเป็นเหตุผลหลักที่ตัวนี้มีอยู่
  const rows = await prisma.booking.findMany({
    where: {
      shootDate: { gte: from, lt: to },
      OR: [
        { roomBookingNo: { not: null } },
        { deletedAt: null, status: 'CONFIRMED' },
      ],
    },
    select: {
      ...ROOM_BOOKING_SELECT,
      roomBookingNo: true, roomBookingRef: true, roomBookingStatus: true, roomBookingAt: true,
      roomBookingError: true,
      status: true, deletedAt: true,
    },
    orderBy: { shootDate: 'asc' },
  })

  /** คนของงานนี้จองห้องเองไว้แล้วไหม — คืนชื่อคนจอง ถ้าใช่ (ใช้ข้อมูลเดือนที่อ่านมาแล้ว) */
  async function manualHeld(bk: any, p: any): Promise<string | null> {
    const key = `${bk.shootDate.getUTCFullYear()}-${bk.shootDate.getUTCMonth() + 1}`
    if (!monthRows.has(key)) await liveIndex(bk.shootDate)
    const rows = monthRows.get(key)
    if (!rows) return null
    const startAt = bangkokToUtcIso(p.startDate, p.startTime)
    const endAt = bangkokToUtcIso(p.endDate, p.endTime)
    if (!startAt || !endAt) return null
    const hold = findManualHold(rows, { roomId: p.roomId, startAt, endAt },
                                [bk.producerEmail, bk.createdByEmail],
                                roomBookingMarker(bk.bookingCode || bk.id))
    return hold ? (hold.bookedBy || 'มีคน') : null
  }

  const out: RoomReconcileResult = {
    scanned: rows.length, staleCancelled: [], staleStuck: [],
    wrongRoomReleased: [], vanished: [], notEnabled: [], booked: [], failed: [], dryRun,
  }
  let writes = 0

  /**
   * v1.207 — การจองที่ยังมีชีวิตในระบบเขา ดึงเดือนละครั้งแล้วใช้ร่วมกัน
   *
   * ต้องมีเพราะเดิม reconciler ตรวจแค่ "ห้องที่ไม่ควรถูกยึด" — **ไม่เคยยืนยันว่า
   * ห้องที่เราคิดว่าจองไว้ยังอยู่จริง** ถ้ามีคนไปยกเลิกในพอร์ทัล (หรือ IT ลบ)
   * เราจะเชื่อว่ายังมีห้องตลอดไป ทั้งที่ห้องว่างและกองไม่มีที่ถ่าย
   * ไม่มีอะไรจับได้เลยจนถึงวันถ่าย
   */
  type LiveRoom = { roomId: number | null; startAt: string | null; endAt: string | null }
  const monthCache = new Map<string, Map<string, LiveRoom>>()
  // v1.227 — แถวดิบของเดือนนั้น เก็บจากการอ่าน**ครั้งเดียวกัน** ไม่เพิ่มรอบอ่าน
  // ใช้ให้ dry-run ตอบตรงกับของจริงได้ (ดูคอมเมนต์ที่ `manualHeld` ข้างล่าง)
  const monthRows = new Map<string, Awaited<ReturnType<typeof listRoomBookings>>>()
  async function liveIndex(d: Date): Promise<Map<string, LiveRoom> | null> {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1
    const key = `${y}-${m}`
    if (monthCache.has(key)) return monthCache.get(key)!
    try {
      const list = await listRoomBookings(y, m)
      monthRows.set(key, list)
      const idx = new Map<string, LiveRoom>()
      for (const r of list) {
        // นับเฉพาะรายการที่ยังมีชีวิต — รายการที่ถูกยกเลิกแล้วต้องไม่ทำให้เราคิดว่าห้องยังอยู่
        if (!r.live) continue
        const v: LiveRoom = { roomId: r.roomId, startAt: r.startAt, endAt: r.endAt }
        if (r.bookingNo) idx.set(`no:${r.bookingNo}`, v)
        if (r.id !== null) idx.set(`id:${r.id}`, v)
      }
      monthCache.set(key, idx)
      return idx
    } catch {
      // อ่านไม่ได้ = ตัดสินไม่ได้ → ห้ามสรุปว่าหาย (จะกลายเป็นจองซ้ำ)
      return null
    }
  }

  /** เวลาสองค่าเท่ากันไหม — เทียบเป็นเวลาจริง ไม่ใช่เทียบตัวอักษร */
  const sameInstant = (a: string | null, b: string | null) =>
    a != null && b != null && Date.parse(a) === Date.parse(b)

  for (const b of rows as any[]) {
    if (writes >= max) break
    const code = b.bookingCode || b.id
    const want = expectedTarget(b)

    // ── 1+2. มีห้องจองไว้ แต่ไม่ควรมี / ไม่ตรงกับที่ควรเป็น ─────────────────
    if (b.roomBookingNo) {
      // ข้อมูลไม่พอจะตัดสิน → ห้ามแตะห้องที่ยึดไว้ รายงานให้คนดูแทน
      if (want.kind === 'unknown') {
        out.staleStuck.push({ code, bookingNo: b.roomBookingNo, reason: `ตัดสินไม่ได้ (${want.reason}) — ไม่แตะห้อง` })
        continue
      }
      const heldWrongly = want.kind === 'none'

      // v1.222 — เทียบกับ **ของจริงในระบบเขา** ไม่ใช่เทียบของเรากับตัวเราเอง
      //
      // เดิม: roomChanged = want.roomId !== roomIdForLocation(b.locationId)
      // ซึ่ง want.roomId ก็มาจาก roomIdForLocation(b.locationId) ตัวเดียวกัน
      // → เป็นเท็จเสมอ ไม่เคยจับอะไรได้เลย และไม่มีบรรทัดไหนเทียบ "เวลา" ด้วย
      // ผลคือ ย้ายห้อง/เลื่อนเวลาบนใบที่จองไปแล้ว = ห้องเดิมค้างที่ช่วงเวลาเดิม
      // ตลอดไป ช่วงใหม่ไม่มีห้อง และ syncRoomBooking ก็ไม่จองใหม่เพราะเห็นว่า
      // roomBookingNo มีค่าแล้ว (SKIPPED already-booked) — เงียบสนิททุกทาง
      let mismatch: string | null = null
      if (!heldWrongly) {
        const idx = await liveIndex(b.shootDate)
        // อ่านระบบเขาไม่ได้ = ตัดสินไม่ได้ → ข้ามใบนี้ไปเลย ห้ามเดาทั้งสองทาง
        if (idx === null) continue
        const actual = (b.roomBookingRef != null ? idx.get(`id:${b.roomBookingRef}`) : undefined)
          ?? idx.get(`no:${b.roomBookingNo}`)
        if (!actual) {
          // ไม่อยู่ในระบบเขาแล้ว — เคส "ห้องหาย" จัดการในบล็อกถัดไป
        } else if (actual.roomId !== null && actual.roomId !== want.target.roomId) {
          mismatch = `ย้ายห้อง (จองไว้ห้อง ${actual.roomId} ควรเป็น ${want.target.roomId})`
        } else if (actual.startAt == null || actual.endAt == null
                   || Number.isNaN(Date.parse(actual.startAt)) || Number.isNaN(Date.parse(actual.endAt))) {
          // v1.222 review fix — เวลาที่อ่านมาไม่ได้/อ่านไม่ออก = **ตัดสินไม่ได้**
          // ไม่ใช่ "เวลาไม่ตรง". เดิม sameInstant คืน false เมื่อเจอ null ซึ่งไหลไป
          // เป็น mismatch แล้วสั่งยกเลิกห้อง — ถ้าวันหนึ่งฟีดเขาหยุดส่ง startAt/endAt
          // (หรือเปลี่ยนชื่อฟิลด์) เราจะปลดห้องทิ้งทั้งระบบในรอบเดียว
          out.staleStuck.push({ code, bookingNo: b.roomBookingNo, reason: 'ระบบกลางไม่ได้ส่งเวลามา — ตัดสินไม่ได้ ไม่แตะห้อง' })
          continue
        } else if (!sameInstant(actual.startAt, want.target.startAt) || !sameInstant(actual.endAt, want.target.endAt)) {
          mismatch = `เลื่อนเวลา (จองไว้ ${actual.startAt}–${actual.endAt} ควรเป็น ${want.target.startAt}–${want.target.endAt})`
        }
      }

      if (heldWrongly || mismatch) {
        if (dryRun) {
          out.staleStuck.push({ code, bookingNo: b.roomBookingNo, reason: heldWrongly ? 'คิวยกเลิก/ถูกลบแล้ว' : mismatch! })
          continue
        }
        writes++
        // v1.206 — ใช้ id ที่เก็บไว้ตอนจองก่อน ประหยัด request และไม่พึ่ง marker ใน title
        // v1.222 — "อ่านระบบเขาไม่ได้" ≠ "ไม่มีการจองอยู่"
        //
        // เดิม `.catch(() => null)` ยุบสองเรื่องนี้เป็นค่าเดียว แล้วบรรทัดล่าง
        // ก็ล้าง roomBookingNo ทิ้งทั้งที่ห้องยังถูกยึดอยู่ฝั่งเขา ผลคือห้องค้าง
        // ถาวรแบบไม่มีอะไรชี้กลับมาได้ และรอบถัดไปเราจะ "จองใหม่" ทับของเดิม
        // = จองซ้ำ ในระบบที่ไม่มี idempotency. เช้าวันที่ 16 ก.ย. DB ของเขาล่ม
        // จริง ๆ อยู่ ~10 นาที ซึ่งเป็นหน้าต่างที่บั๊กนี้ทำงานได้พอดี
        // (ตรวจแล้วยังไม่เกิดความเสียหาย — 67 ใบ รหัสไม่ซ้ำ)
        let found: { id: number; bookingNo: string } | null = null
        if (b.roomBookingRef != null) {
          found = { id: b.roomBookingRef as number, bookingNo: b.roomBookingNo as string }
        } else {
          try {
            const hit = await findExistingRoomBooking(code, b.shootDate.getUTCFullYear(), b.shootDate.getUTCMonth() + 1)
            found = hit && hit.id !== null ? { id: hit.id, bookingNo: hit.bookingNo } : null
          } catch (e: any) {
            // ตัดสินไม่ได้ → ไม่แตะอะไรเลย ปล่อยให้รอบหน้าตัดสิน
            out.staleStuck.push({ code, bookingNo: b.roomBookingNo, reason: `อ่านระบบกลางไม่ได้: ${e?.message || e}` })
            continue
          }
        }
        if (!found) {
          // อ่านได้จริง และไม่มีอยู่ในระบบเขาแล้ว — ล้างของเราให้ตรงความจริง
          await stampCleared(b.id, 'ไม่พบการจองในระบบกลาง')
          out.staleCancelled.push(code)
          continue
        }
        const res = await cancelRoomBooking(found.id)
        if (res.kind === 'ok') {
          await stampCleared(b.id, `ยกเลิกแล้ว (เดิม ${found.bookingNo})`)
          ;(heldWrongly ? out.staleCancelled : out.wrongRoomReleased).push(code)
          // v1.222.1 — ปลดเพราะ "ห้อง/เวลาไม่ตรง" ต้องจองคืนใน**รอบเดียวกัน**
          // ไม่ใช่ `continue` แล้วรออีกชั่วโมง ระหว่างนั้นกองไม่มีห้องเลย
          // (เจอจริง: NWS-ENG-260917-01 ถูกปลดตอนกลางคืน กองถ่าย 10 โมงเช้า)
          // ล้างค่าในหน่วยความจำแล้วปล่อยให้ไหลลงบล็อก 3 ซึ่งจองผ่าน
          // syncRoomBooking ที่อ่านกลับก่อนยิงเสมอ จึงไม่มีทางจองซ้ำ
          if (!heldWrongly) (b as any).roomBookingNo = null
          logAudit({
            actorEmail: 'room-reconcile', action: 'booking.room_cancelled',
            entityType: 'Booking', entityId: b.id, bookingCode: b.bookingCode,
            changes: { bookingNo: found.bookingNo, reason: heldWrongly ? 'booking-cancelled' : 'schedule-changed', detail: mismatch || undefined },
          })
        } else if (res.kind === 'not-found') {
          // ไม่มีอยู่แล้วฝั่งเขา — ล้างของเราให้ตรง ไม่งั้นวนลองทุกชั่วโมงตลอดไป
          await stampCleared(b.id, 'ไม่พบการจองในระบบกลาง (อาจถูกยกเลิกไปแล้ว)')
          out.staleCancelled.push(code)
          if (!heldWrongly) (b as any).roomBookingNo = null
        } else {
          out.staleStuck.push({ code, bookingNo: found.bookingNo, reason: res.kind === 'forbidden' ? 'คีย์ยังไม่มีสิทธิ์ยกเลิก' : res.message })
          continue
        }
        // ปลดสำเร็จ (หรือไม่มีให้ปลด) — ถ้าเป็นเคสห้อง/เวลาไม่ตรง ให้ไหลต่อไปจองคืน
        if (heldWrongly) continue
      }
    }

    // ── 2.5 เราคิดว่าจองไว้ และควรมีจริง — แต่ยังอยู่ในระบบเขาไหม ──────────
    if (b.roomBookingNo && want.kind === 'target') {
      const live = await liveIndex(b.shootDate)
      if (live !== null) {
        const stillThere = live.has(`no:${b.roomBookingNo}`)
          || (b.roomBookingRef != null && live.has(`id:${b.roomBookingRef}`))
        if (!stillThere) {
          out.vanished.push(code)
          if (!dryRun) {
            // ล้างของเราให้ตรงความจริงก่อน — ไม่งั้นรอบหน้าก็ยังคิดว่ามีห้อง
            await stampCleared(b.id, 'หายไปจากระบบกลาง (มีคนยกเลิกฝั่งนั้น?)')
            logAudit({
              actorEmail: 'room-reconcile', action: 'booking.room_vanished',
              entityType: 'Booking', entityId: b.id, bookingCode: b.bookingCode,
              changes: { bookingNo: b.roomBookingNo, roomBookingRef: b.roomBookingRef },
            })
            // เปิดจองอัตโนมัติอยู่ → จองคืนให้เลยในบล็อกถัดไปของรอบนี้
            ;(b as any).roomBookingNo = null
          }
        }
      }
    }

    // ── 3. ควรมีห้องแต่ยังไม่มี ────────────────────────────────────────────
    // v1.222 — เว้นวรรคใบที่เพิ่งได้ CONFLICT มา. "ห้องเต็ม" ไม่ใช่ error ชั่วคราว
    // การยิงซ้ำทุกชั่วโมงจึงไม่ได้ช่วยอะไร แต่กินโควตา 20 req/5 นาที ที่ใช้ร่วม
    // กันทั้งบริษัท ทับใบอื่นที่จองได้จริง และเด้งเข้ากลุ่ม LINE แอดมินของ IT ทุกรอบ
    // (ใบเดียวยิงได้ถึง ~1,000 ครั้งกว่าจะพ้นหน้าต่าง 45 วัน). ยังลองใหม่อยู่ —
    // แค่ทุก 6 ชม. เผื่อคนที่จองทับไว้ยกเลิกไป
    if (!b.roomBookingNo && b.roomBookingStatus === 'CONFLICT' && b.roomBookingAt
        && Date.now() - new Date(b.roomBookingAt).getTime() < CONFLICT_RETRY_MS) {
      out.staleStuck.push({ code, bookingNo: null, reason: 'ห้องไม่ว่าง — รอรอบถัดไป (6 ชม.)' })
      continue
    }
    // v1.227 — ห้องที่ยังไม่เปิดให้จองอัตโนมัติ: ข้ามได้ แต่ **ต้องเขียนสถานะไว้**
    // ไม่งั้นการ์ดใบจองเงียบสนิทและคนเข้าใจว่าห้องถูกจองให้แล้ว
    // ไม่นับเป็น `writes` เพราะไม่ได้ยิงระบบเขาเลย (ไม่กินโควตา)
    if (!b.roomBookingNo && want.kind === 'target' && roomBookingEnabled()
        && !roomBookingAllowed(want.target.roomId)) {
      // เขียนเฉพาะตอนค่าเปลี่ยนจริง — ไม่งั้น `roomBookingAt` ถูกดันใหม่ทุกชั่วโมง
      // จนอ่านเหมือน "เพิ่งพยายามเมื่อกี้" ทั้งที่ไม่ได้ทำอะไรเลย
      const already = b.roomBookingStatus === 'SKIPPED'
        && b.roomBookingError === 'skip: room-not-enabled'
      if (!dryRun && !already) await stampSkipped(b.id, 'room-not-enabled')
      out.notEnabled.push(code)
      continue
    }
    if (!b.roomBookingNo && want.kind === 'target' && roomBookingEnabled() && roomBookingAllowed(want.target.roomId)) {
      const built = buildPayloadForBooking(b)
      if ('skip' in built || 'error' in built) continue
      if (dryRun) {
        // **preview ต้องไม่โกหก** — ของจริง `syncRoomBooking` จะเช็คก่อนว่าคนของงานนี้
        // จองห้องเองไว้แล้วหรือยัง แล้วข้าม ถ้า dry-run ตัดจบตรงนี้เฉย ๆ มันจะรายงาน
        // ว่า "จะจอง" ทั้งที่ของจริงไม่จอง — คนอ่าน preview เพื่อ**ตัดสินใจ** ฉะนั้น
        // preview ที่ต่างจากของจริงคือ preview ที่ไม่ควรมี (บทเรียน v1.202.3)
        const held = await manualHeld(b, built.payload)
        out.booked.push(held
          ? { code, bookingNo: `(ข้าม — ${held} จองห้องเองไว้แล้ว)` }
          : { code, bookingNo: '(จะจอง)' })
        continue
      }
      writes++
      // ผ่าน syncRoomBooking เท่านั้น — มันอ่านกลับก่อนยิงเสมอ (กันจองซ้ำ)
      const r = await syncRoomBooking(b.id)
      if (r.status === 'OK') out.booked.push({ code, bookingNo: r.bookingNo })
      else if (r.status !== 'SKIPPED') out.failed.push({ code, status: r.status, message: (r as any).message })
      // เว้นจังหวะ — rate limit ของเขา 20 req/5 นาที และแต่ละใบกิน 2 request
      await new Promise(res => setTimeout(res, 1200))
    }
  }

  // เตือนเฉพาะสิ่งที่ตัวเองแก้ไม่ได้ — ไม่ใช่รายงานทุกอย่างจนกลายเป็น noise
  if (!dryRun && out.vanished.length > 0 && !roomBookingEnabled()) {
    // จองอัตโนมัติปิดอยู่ → จองคืนเองไม่ได้ ต้องบอกคน
    await notifyChat(
      `🚪 **ห้องหายไปจากระบบกลาง ${out.vanished.length} รายการ**\n` +
      `probook คิดว่าจองไว้ แต่ไม่พบในระบบแล้ว (น่าจะมีคนยกเลิกฝั่งนั้น)\n\n` +
      out.vanished.map(c => `• ${c}`).join('\n') +
      `\n\nกองพวกนี้กำลังจะไม่มีห้อง — จองใหม่ที่ https://service.thestandard.co/booking หรือเปิด ROOM_BOOKING_ENABLED ให้ระบบจองคืนเอง`,
    ).catch(e => console.error('[room-reconcile] chat alert failed:', e?.message || e))
  }

  if (!dryRun && out.staleStuck.length > 0) {
    const lines = out.staleStuck.map(s => `• ${s.bookingNo} — ${s.code} (${s.reason})`).join('\n')
    await notifyChat(
      `🚪 **ห้องค้างในระบบกลาง ${out.staleStuck.length} รายการ**\n` +
      `คิวถ่ายยกเลิก/ย้ายไปแล้ว แต่ผมปลดห้องเองไม่ได้\n\n${lines}\n\n` +
      `ปลดมือที่ https://service.thestandard.co/booking — หรือรอ IT เปิดสิทธิ์ยกเลิกให้ service key แล้วผมจะเก็บกวาดเองรอบถัดไป`,
    ).catch(e => console.error('[room-reconcile] chat alert failed:', e?.message || e))
  }

  return out
}

async function stampCleared(id: string, note: string) {
  await prisma.booking.update({
    where: { id },
    data: {
      roomBookingNo: null,
      roomBookingRef: null,
      roomBookingStatus: 'SKIPPED',
      roomBookingError: note,
      roomBookingAt: new Date(),
    },
  })
}
