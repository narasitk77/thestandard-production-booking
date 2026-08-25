import { prisma } from './db'
import { logAudit } from './audit'
import { bookingDisplayName } from './display'
import {
  roomTargetForBooking, roomIdForLocation, buildRoomBookingPayload,
  createRoomBooking, findExistingRoomBooking, cancelRoomBooking,
  roomBookingEnabled, roomBookingAllowed, RoomSkipReason,
} from './room-booking'

/**
 * จองห้องในระบบกลางให้คิวถ่ายหนึ่งใบ — **at-most-once**
 *
 * v1.200 — ระบบกลางไม่มี idempotency (ยิงซ้ำ = จองซ้ำ) ลำดับจึงต้องเป็นแบบนี้เสมอ:
 *
 *   1. มี `roomBookingNo` แล้ว → จบ ไม่ยิง
 *   2. **อ่านกลับก่อนยิงเสมอ** — ถ้าเจอ marker `[PB-<code>]` ในปฏิทินของเขา
 *      แปลว่ารอบก่อนยิงติดแล้วแต่เราไม่ได้บันทึก → เก็บเลขแล้วจบ ไม่ยิงซ้ำ
 *   3. ค่อยยิง
 *   4. ผล `unknown` (timeout) → **ห้ามสรุปว่าล้มเหลว** บันทึกเป็น UNKNOWN แล้วให้
 *      รอบหน้าอ่านกลับ (ข้อ 2) เป็นคนตัดสิน
 *
 * ราคาของการอ่านกลับคือ 1 request ต่อการจอง — ถูกกว่าห้องถูกจองซ้ำมาก
 */
export type RoomSyncResult =
  | { status: 'OK'; bookingNo: string; adopted?: boolean }
  | { status: 'SKIPPED'; reason: RoomSkipReason | 'disabled' | 'room-not-enabled' | 'already-booked' }
  | { status: 'CONFLICT'; message: string }
  | { status: 'INVALID'; message: string }
  | { status: 'UNKNOWN'; message: string }


/** รูปแบบข้อมูลใบจองที่ต้องใช้ประกอบ payload — ให้ทั้งสองเส้นทาง select เหมือนกัน */
export const ROOM_BOOKING_SELECT = {
  id: true, bookingCode: true, locationId: true, locationName: true,
  shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
  producer: true, producerEmail: true,
  // projectName + program ของ "แต่ละตอน" จำเป็นสำหรับ bookingDisplayName —
  // ชื่อรายการจริงอยู่ที่ตอน ส่วน program ระดับใบจองมักเป็นแค่ประเภทเนื้อหา
  // ("Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว") ซึ่งเอาไปตั้งชื่อการจองห้องไม่ได้
  projectName: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true } },
  episodes: {
    orderBy: { sequence: 'asc' as const },
    select: { episodeId: true, title: true, program: { select: { name: true } } },
  },
} as const

/**
 * ประกอบ payload จากใบจอง — **ที่เดียวเท่านั้น**
 *
 * v1.202 — เดิม endpoint dry-run ประกอบเองแยกจาก syncRoomBooking ผลคือ preview
 * โชว์ notes คนละแบบกับที่จะส่งจริง. preview ที่โกหกแย่กว่าไม่มี preview เลย
 * เพราะคนดูแล้วอนุมัติจากสิ่งที่ไม่ใช่ของจริง
 */
export function buildPayloadForBooking(b: {
  id: string; bookingCode: string | null; locationId: string | null
  shootDate: Date; shootEndDate: Date | null
  callTime: string; estimatedWrap: string | null
  producer: string | null; producerEmail: string | null
  projectName?: string | null
  outlet: { code: string; name: string }; program: { name: string }
  episodes: { episodeId: string; title: string; program?: { name: string } | null }[]
}): { payload: ReturnType<typeof buildRoomBookingPayload> extends any ? any : never } | { skip: RoomSkipReason } | { error: string } {
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const target = roomTargetForBooking({
    locationId: b.locationId,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap,
  })
  if ('skip' in target) return { skip: target.skip }
  const roomId = roomIdForLocation(b.locationId)!
  const code = b.bookingCode || b.id

  // ใช้ bookingDisplayName — กฎ "ใบจองนี้ชื่ออะไร" ที่ทั้งระบบใช้ร่วมกัน
  // (ปฏิทิน, my-bookings, อีเมล) เขียนเองซ้ำแล้วได้ชื่อผิด: ครั้งแรกได้ "NWS · -"
  // เพราะชื่อตอนเป็น "-" ครั้งที่สองได้ชื่อ *ประเภทเนื้อหา* เพราะ program ระดับ
  // ใบจองคือ bucket ไม่ใช่ชื่อรายการ — ชื่อจริงอยู่ที่ program ของแต่ละตอน
  const showName = [b.outlet.code, bookingDisplayName(b)].filter(Boolean).join(' · ')

  const built = buildRoomBookingPayload({
    roomId, bookingCode: code, showName,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime, estimatedWrap: b.estimatedWrap,
    producerName: b.producer, producerEmail: b.producerEmail,
    department: b.outlet.name,
    // ต้องมีอะไรยึดโยงสองระบบได้ (operator 2026-08-25)
    notes: [
      `Production ID: ${b.episodes.map(e => e.episodeId).join(', ') || code}`,
      'จองอัตโนมัติจากระบบคิวถ่าย Probook',
    ].join('\n'),
  })
  if ('error' in built) return { error: built.error }
  return { payload: built.payload }
}

export async function syncRoomBooking(bookingId: string, opts: { force?: boolean } = {}): Promise<RoomSyncResult> {
  if (!roomBookingEnabled() && !opts.force) return { status: 'SKIPPED', reason: 'disabled' }

  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    // v1.202.3 — ต้องใช้ select ชุดเดียวกับ dry-run เป๊ะ ไม่งั้นตัวประกอบ payload
    // ตัวเดียวกันได้ข้อมูลไม่เท่ากันสองทาง แล้ว preview ก็ยังโกหกอยู่ดี
    // (ของจริง: dry-run ได้ชื่อ "7 THINGS WE LOVE ABOUT..." แต่ที่จองจริงได้
    //  "OG EP.1 / OG EP.2" เพราะทางนี้ไม่ได้ดึง projectName + program ของตอน)
    select: {
      ...ROOM_BOOKING_SELECT,
      roomBookingNo: true, status: true, deletedAt: true,
    },
  })
  // งานที่ยกเลิก/ถูกลบไม่ต้องจองห้อง — ส่วนสถานะอื่น (รวม COMPLETED ตอนทดสอบย้อนหลัง)
  // ปล่อยผ่าน เพราะผู้เรียกเป็นคนเลือกใบมาแล้ว
  if (!b || b.deletedAt || b.status === 'CANCELLED') return { status: 'SKIPPED', reason: 'no-location' }
  if (b.roomBookingNo) return { status: 'SKIPPED', reason: 'already-booked' }

  const code = b.bookingCode || b.id
  const built = buildPayloadForBooking(b)
  if ('skip' in built) {
    await stamp(b.id, 'SKIPPED', null, built.skip)
    return { status: 'SKIPPED', reason: built.skip }
  }
  if ('error' in built) {
    await stamp(b.id, 'INVALID', built.error)
    return { status: 'INVALID', message: built.error }
  }
  const roomId = built.payload.roomId
  if (!roomBookingAllowed(roomId)) return { status: 'SKIPPED', reason: 'room-not-enabled' }

  // ── ขั้นที่ 2: อ่านกลับก่อนยิงเสมอ ────────────────────────────────────────
  const d = b.shootDate
  try {
    const existing = await findExistingRoomBooking(code, d.getUTCFullYear(), d.getUTCMonth() + 1)
    if (existing) {
      await stamp(b.id, 'OK', null, undefined, existing.bookingNo)
      logAudit({
        actorEmail: 'room-booking', action: 'booking.room_reserved', entityType: 'Booking',
        entityId: b.id, bookingCode: b.bookingCode,
        changes: { bookingNo: existing.bookingNo, adopted: true, note: 'เจอการจองเดิมในระบบกลาง — ไม่ยิงซ้ำ' },
      })
      return { status: 'OK', bookingNo: existing.bookingNo, adopted: true }
    }
  } catch (e: any) {
    // อ่านกลับไม่ได้ = ตัดสินไม่ได้ว่าเคยยิงไปแล้วหรือยัง → **ไม่ยิง** ปลอดภัยกว่า
    const msg = `อ่านกลับก่อนยิงไม่สำเร็จ: ${e?.message || e}`
    await stamp(b.id, 'UNKNOWN', msg)
    return { status: 'UNKNOWN', message: msg }
  }

  // ── ขั้นที่ 3: ยิงจริง ──────────────────────────────────────────────────
  const out = await createRoomBooking(built.payload)
  const statusMap = { ok: 'OK', conflict: 'CONFLICT', invalid: 'INVALID', unknown: 'UNKNOWN' } as const
  const dbStatus = statusMap[out.kind]
  await stamp(b.id, dbStatus, out.kind === 'ok' ? null : out.message,
              undefined, out.kind === 'ok' ? out.bookingNo : undefined)

  logAudit({
    actorEmail: 'room-booking',
    action: out.kind === 'ok' ? 'booking.room_reserved' : 'booking.room_reserve_failed',
    entityType: 'Booking', entityId: b.id, bookingCode: b.bookingCode,
    // ผลจริง ไม่ใช่เจตนา — บันทึก payload ที่ส่งไปด้วยเพื่อตรวจย้อนหลังได้
    changes: {
      outcome: out.kind,
      ...(out.kind === 'ok' ? { bookingNo: out.bookingNo } : { message: out.message }),
      roomId, title: built.payload.title,
      window: `${built.payload.startDate} ${built.payload.startTime} → ${built.payload.endDate} ${built.payload.endTime}`,
    },
  })

  if (out.kind === 'ok') return { status: 'OK', bookingNo: out.bookingNo }
  if (out.kind === 'conflict') return { status: 'CONFLICT', message: out.message }
  if (out.kind === 'invalid') return { status: 'INVALID', message: out.message }
  return { status: 'UNKNOWN', message: out.message }
}

async function stamp(
  id: string,
  status: string,
  error: string | null,
  skipReason?: string,
  bookingNo?: string,
) {
  await prisma.booking.update({
    where: { id },
    data: {
      roomBookingStatus: status,
      roomBookingError: error || (skipReason ? `skip: ${skipReason}` : null),
      roomBookingAt: new Date(),
      ...(bookingNo ? { roomBookingNo: bookingNo } : {}),
    },
  })
}

/**
 * ยกเลิกการจองห้องของคิวถ่ายใบหนึ่ง
 *
 * หาเลข id ของระบบเขาจาก marker ในปฏิทิน (ไม่เก็บเป็นคอลัมน์ เพราะ bookingNo
 * ที่เราเก็บไว้เป็นคนละเลขกับ id ที่ path ของ cancel ใช้ — อ่านสดตอนจะลบชัวร์กว่า)
 *
 * ล้าง roomBookingNo หลังลบสำเร็จ เพื่อให้ระบบมองว่า "ยังไม่ได้จอง" และจองใหม่ได้
 */
export async function cancelRoomBookingFor(bookingId: string): Promise<
  | { status: 'CANCELLED'; bookingNo: string }
  | { status: 'NOT_FOUND' }
  | { status: 'FORBIDDEN'; message: string }
  | { status: 'UNKNOWN'; message: string }
> {
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingCode: true, shootDate: true, roomBookingNo: true },
  })
  if (!b?.bookingCode) return { status: 'NOT_FOUND' }

  const d = b.shootDate
  let found
  try {
    found = await findExistingRoomBooking(b.bookingCode, d.getUTCFullYear(), d.getUTCMonth() + 1)
  } catch (e: any) {
    return { status: 'UNKNOWN', message: `อ่านปฏิทินระบบกลางไม่สำเร็จ: ${e?.message || e}` }
  }
  if (!found || found.id === null) {
    // ไม่มีอยู่แล้ว — ล้างสถานะฝั่งเราให้ตรงความจริง
    await prisma.booking.update({
      where: { id: b.id },
      data: { roomBookingNo: null, roomBookingStatus: 'SKIPPED', roomBookingError: 'ไม่พบการจองในระบบกลาง', roomBookingAt: new Date() },
    })
    return { status: 'NOT_FOUND' }
  }

  const out = await cancelRoomBooking(found.id)
  logAudit({
    actorEmail: 'room-booking', action: 'booking.room_cancelled', entityType: 'Booking',
    entityId: b.id, bookingCode: b.bookingCode,
    changes: { outcome: out.kind, bookingNo: found.bookingNo, roomBookingId: found.id, ...('message' in out ? { message: out.message } : {}) },
  })

  if (out.kind === 'ok') {
    await prisma.booking.update({
      where: { id: b.id },
      data: { roomBookingNo: null, roomBookingStatus: 'SKIPPED', roomBookingError: `ยกเลิกแล้ว (เดิม ${found.bookingNo})`, roomBookingAt: new Date() },
    })
    return { status: 'CANCELLED', bookingNo: found.bookingNo }
  }
  if (out.kind === 'not-found') return { status: 'NOT_FOUND' }
  if (out.kind === 'forbidden') return { status: 'FORBIDDEN', message: out.message }
  return { status: 'UNKNOWN', message: out.message }
}

/**
 * คืนห้องในระบบกลางเมื่อคิวถูกยกเลิก/ลบ — fire-and-forget
 *
 * v1.201 (operator 2026-08-25: *"เมื่อคิวยกเลิกจาก probook ห้องต้องยกเลิกด้วย"*)
 *
 * เรียกจากทุกเส้นทางที่ทำให้คิว "ไม่เกิดขึ้นแล้ว": ยกเลิกสถานะ, soft-delete,
 * ยกเลิก routine ทั้งกลุ่ม. ห้ามทำให้การยกเลิกคิวล้มเหลว — เส้นเดียวกับปฏิทิน/OT
 *
 * ออกทันทีถ้าใบนั้นไม่เคยจองห้องไว้ (ไม่มี roomBookingNo) จึงไม่ยิงเน็ตเปล่า ๆ
 * ตอน flag ปิดอยู่หรือคิวไม่ได้ใช้ห้องในตึก
 */
export function releaseRoomForBooking(bookingId: string, reason: string): void {
  void (async () => {
    try {
      const b = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { roomBookingNo: true, bookingCode: true },
      })
      if (!b?.roomBookingNo) return
      const r = await cancelRoomBookingFor(bookingId)
      if (r.status !== 'CANCELLED') {
        // คืนห้องไม่สำเร็จ = ห้องค้างอยู่ในระบบเขาโดยไม่มีใครใช้ ต้องเห็น ไม่ใช่เงียบ
        console.warn(`[room-booking] คืนห้องไม่สำเร็จ ${b.bookingCode} (${reason}):`, r)
        logAudit({
          actorEmail: 'room-booking', action: 'booking.room_release_failed',
          entityType: 'Booking', entityId: bookingId, bookingCode: b.bookingCode,
          changes: { reason, ...r },
        })
      }
    } catch (e: any) {
      console.error('[room-booking] releaseRoomForBooking error:', e?.message || e)
    }
  })()
}
