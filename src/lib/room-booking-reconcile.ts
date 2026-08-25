import { prisma } from './db'
import { logAudit } from './audit'
import { notifyDiscord } from './notify'
import {
  findExistingRoomBooking, cancelRoomBooking, roomIdForLocation,
  roomTargetForBooking, roomBookingEnabled, roomBookingAllowed,
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

export interface RoomReconcileResult {
  scanned: number
  staleCancelled: string[]     // ห้องค้างที่ยกเลิกสำเร็จ
  staleStuck: { code: string; bookingNo: string; reason: string }[]  // ยกเลิกไม่ได้ ต้องมือ
  wrongRoomReleased: string[]  // ห้อง/เวลาไม่ตรง ปลดของเดิมแล้ว
  booked: { code: string; bookingNo: string }[]
  failed: { code: string; status: string; message?: string }[]
  dryRun: boolean
}

/** ห้องที่ควรถูกยึดไว้ให้คิวนี้ตอนนี้ — null = ไม่ควรมีห้องเลย */
function expectedTarget(b: any): { roomId: number; startAt: string; endAt: string } | null {
  if (b.deletedAt || b.status === 'CANCELLED') return null
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const t = roomTargetForBooking({
    locationId: b.locationId,
    shootDate: ymd(b.shootDate),
    shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap,
  })
  return 'skip' in t ? null : t.target
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
      roomBookingNo: true, roomBookingStatus: true, status: true, deletedAt: true,
    },
    orderBy: { shootDate: 'asc' },
  })

  const out: RoomReconcileResult = {
    scanned: rows.length, staleCancelled: [], staleStuck: [],
    wrongRoomReleased: [], booked: [], failed: [], dryRun,
  }
  let writes = 0

  for (const b of rows as any[]) {
    if (writes >= max) break
    const code = b.bookingCode || b.id
    const want = expectedTarget(b)

    // ── 1+2. มีห้องจองไว้ แต่ไม่ควรมี / ไม่ตรงกับที่ควรเป็น ─────────────────
    if (b.roomBookingNo) {
      const heldWrongly = want === null
      const roomChanged = want !== null && roomIdForLocation(b.locationId) !== null
        && want.roomId !== roomIdForLocation(b.locationId)
      if (heldWrongly || roomChanged) {
        if (dryRun) {
          out.staleStuck.push({ code, bookingNo: b.roomBookingNo, reason: heldWrongly ? 'คิวยกเลิก/ถูกลบแล้ว' : 'ย้ายห้อง' })
          continue
        }
        writes++
        const found = await findExistingRoomBooking(code, b.shootDate.getUTCFullYear(), b.shootDate.getUTCMonth() + 1)
          .catch(() => null)
        if (!found || found.id === null) {
          // ไม่มีอยู่ในระบบเขาแล้ว — ล้างของเราให้ตรงความจริง
          await stampCleared(b.id, 'ไม่พบการจองในระบบกลาง')
          out.staleCancelled.push(code)
          continue
        }
        const res = await cancelRoomBooking(found.id)
        if (res.kind === 'ok') {
          await stampCleared(b.id, `ยกเลิกแล้ว (เดิม ${found.bookingNo})`)
          ;(heldWrongly ? out.staleCancelled : out.wrongRoomReleased).push(code)
          logAudit({
            actorEmail: 'room-reconcile', action: 'booking.room_cancelled',
            entityType: 'Booking', entityId: b.id, bookingCode: b.bookingCode,
            changes: { bookingNo: found.bookingNo, reason: heldWrongly ? 'booking-cancelled' : 'room-changed' },
          })
        } else {
          out.staleStuck.push({ code, bookingNo: found.bookingNo, reason: res.kind === 'forbidden' ? 'คีย์ยังไม่มีสิทธิ์ยกเลิก' : ('message' in res ? res.message : res.kind) })
        }
        continue
      }
    }

    // ── 3. ควรมีห้องแต่ยังไม่มี ────────────────────────────────────────────
    if (!b.roomBookingNo && want !== null && roomBookingEnabled() && roomBookingAllowed(want.roomId)) {
      const built = buildPayloadForBooking(b)
      if ('skip' in built || 'error' in built) continue
      if (dryRun) { out.booked.push({ code, bookingNo: '(จะจอง)' }); continue }
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
  if (!dryRun && out.staleStuck.length > 0) {
    const lines = out.staleStuck.map(s => `• ${s.bookingNo} — ${s.code} (${s.reason})`).join('\n')
    await notifyDiscord(
      `🚪 **ห้องค้างในระบบกลาง ${out.staleStuck.length} รายการ**\n` +
      `คิวถ่ายยกเลิก/ย้ายไปแล้ว แต่ผมปลดห้องเองไม่ได้\n\n${lines}\n\n` +
      `ปลดมือที่ https://service.thestandard.co/booking — หรือรอ IT เปิดสิทธิ์ยกเลิกให้ service key แล้วผมจะเก็บกวาดเองรอบถัดไป`,
    ).catch(e => console.error('[room-reconcile] discord failed:', e?.message || e))
  }

  return out
}

async function stampCleared(id: string, note: string) {
  await prisma.booking.update({
    where: { id },
    data: {
      roomBookingNo: null,
      roomBookingStatus: 'SKIPPED',
      roomBookingError: note,
      roomBookingAt: new Date(),
    },
  })
}
