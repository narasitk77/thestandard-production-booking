import { prisma } from './db'
import { logAudit } from './audit'
import {
  roomTargetForBooking, roomIdForLocation, buildRoomBookingPayload,
  createRoomBooking, findExistingRoomBooking, roomBookingEnabled, roomBookingAllowed,
  RoomSkipReason,
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

export async function syncRoomBooking(bookingId: string, opts: { force?: boolean } = {}): Promise<RoomSyncResult> {
  if (!roomBookingEnabled() && !opts.force) return { status: 'SKIPPED', reason: 'disabled' }

  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingCode: true, locationId: true, shootDate: true, shootEndDate: true,
      callTime: true, estimatedWrap: true, producer: true, producerEmail: true,
      roomBookingNo: true, status: true, deletedAt: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, title: true } },
    },
  })
  // งานที่ยกเลิก/ถูกลบไม่ต้องจองห้อง — ส่วนสถานะอื่น (รวม COMPLETED ตอนทดสอบย้อนหลัง)
  // ปล่อยผ่าน เพราะผู้เรียกเป็นคนเลือกใบมาแล้ว
  if (!b || b.deletedAt || b.status === 'CANCELLED') return { status: 'SKIPPED', reason: 'no-location' }
  if (b.roomBookingNo) return { status: 'SKIPPED', reason: 'already-booked' }

  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const target = roomTargetForBooking({
    locationId: b.locationId,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap,
  })
  if ('skip' in target) {
    await stamp(b.id, 'SKIPPED', null, target.skip)
    return { status: 'SKIPPED', reason: target.skip }
  }
  const roomId = roomIdForLocation(b.locationId)!
  if (!roomBookingAllowed(roomId)) return { status: 'SKIPPED', reason: 'room-not-enabled' }

  const code = b.bookingCode || b.id
  const showName = [b.outlet.code, b.episodes[0]?.title?.trim() || b.program.name]
    .filter(Boolean).join(' · ')

  const built = buildRoomBookingPayload({
    roomId, bookingCode: code, showName,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime, estimatedWrap: b.estimatedWrap,
    producerName: b.producer, producerEmail: b.producerEmail,
    department: b.outlet.name,
    notes: b.episodes.map(e => e.episodeId).join(', '),
  })
  if ('error' in built) {
    await stamp(b.id, 'INVALID', built.error)
    return { status: 'INVALID', message: built.error }
  }

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
