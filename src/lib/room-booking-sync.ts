import { prisma } from './db'
import { logAudit } from './audit'
import { bookingDisplayName } from './display'
import { notifyChat } from './notify'
import { alertOps } from './ops-alert'
import {
  describeRoomClash, bkkTime, bangkokToUtcIso,
  roomTargetForBooking, roomIdForLocation, buildRoomBookingPayload,
  createRoomBooking, findExistingRoomBooking, cancelRoomBooking,
  roomBookingEnabled, roomBookingAllowed, RoomSkipReason,
  listRoomBookings, findMarkerBooking, findManualHold, roomBookingMarker,
  ownHoldCoverage, ownRoomRows, overlaps, ROOM_BOOKING_BASE_URL,
} from './room-booking'
import { EPISODE_ORDER } from './episode-order'
import { UNRESOLVED_SKIPS, unresolvedRoomText } from './room-badge'

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
  | { status: 'SKIPPED'; reason: RoomSkipReason | 'disabled' | 'room-not-enabled' | 'already-booked' | 'manual-hold' }
  | { status: 'CONFLICT'; message: string }
  | { status: 'INVALID'; message: string }
  | { status: 'UNKNOWN'; message: string }


/** รูปแบบข้อมูลใบจองที่ต้องใช้ประกอบ payload — ให้ทั้งสองเส้นทาง select เหมือนกัน */
export const ROOM_BOOKING_SELECT = {
  id: true, bookingCode: true, locationId: true, locationName: true,
  shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
  producer: true, producerEmail: true, createdByEmail: true,
  // projectName + program ของ "แต่ละตอน" จำเป็นสำหรับ bookingDisplayName —
  // ชื่อรายการจริงอยู่ที่ตอน ส่วน program ระดับใบจองมักเป็นแค่ประเภทเนื้อหา
  // ("Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว") ซึ่งเอาไปตั้งชื่อการจองห้องไม่ได้
  projectName: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true } },
  episodes: {
    orderBy: EPISODE_ORDER,
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
      roomBookingNo: true, roomBookingStatus: true, roomBookingError: true,
      status: true, deletedAt: true,
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
  if (!roomBookingAllowed(roomId)) {
    // v1.227 — **ข้ามแล้วต้องบอก** เดิม return เฉย ๆ ไม่เขียนสถานะลง DB เลย
    // → roomBookingStatus เป็น null → ไม่มีป้ายบนการ์ด → คนที่จอง War Room
    // เข้าใจว่าห้องถูกจองให้แล้วเหมือน Studio เพราะไม่มีอะไรบอกว่าต่างกัน
    // (ตรวจ 2026-09-18: 4 ใบ CONFIRMED ที่ War Room ไม่มีห้องจองไว้เลย)
    await stamp(b.id, 'SKIPPED', null, 'room-not-enabled')
    return { status: 'SKIPPED', reason: 'room-not-enabled' }
  }

  // ── ขั้นที่ 2: อ่านกลับก่อนยิงเสมอ ────────────────────────────────────────
  const d = b.shootDate
  try {
    // อ่านเดือนครั้งเดียว ใช้ตอบสองคำถาม — โควตาร่วมทั้งบริษัทมีแค่ 20 req/5 นาที
    const month = await listRoomBookings(d.getUTCFullYear(), d.getUTCMonth() + 1)
    const existing = findMarkerBooking(month, code)
    if (existing) {
      await stamp(b.id, 'OK', null, undefined, existing.bookingNo, existing.id)
      logAudit({
        actorEmail: 'room-booking', action: 'booking.room_reserved', entityType: 'Booking',
        entityId: b.id, bookingCode: b.bookingCode,
        changes: { bookingNo: existing.bookingNo, adopted: true, note: 'เจอการจองเดิมในระบบกลาง — ไม่ยิงซ้ำ' },
      })
      return { status: 'OK', bookingNo: existing.bookingNo, adopted: true }
    }

    // v1.227 — คนของงานนี้จองห้องเองไปแล้ว: ห้องได้แล้วจริง ๆ ยิงไปก็ได้แค่ CONFLICT
    // + ป้าย "ห้องไม่ว่าง" บนงานที่ห้องถูกกันไว้ถูกต้อง = สัญญาณหลอก
    // (เจอจริงตอนเปิด War Room: WLT-NGI 2 ใบ โปรดิวเซอร์จองมือไว้เวลาตรงเป๊ะ)
    const p0 = built.payload
    const wantStart = bangkokToUtcIso(p0.startDate, p0.startTime)
    const wantEnd = bangkokToUtcIso(p0.endDate, p0.endTime)
    if (wantStart && wantEnd) {
      const hold = findManualHold(month, { roomId, startAt: wantStart, endAt: wantEnd },
                                  [b.producerEmail, b.createdByEmail], roomBookingMarker(code),
                                  [p0.title.replace(roomBookingMarker(code), '').trim()])   // v1.271 ชื่องานเดียวกัน
      if (hold) {
        // เขียน **เฉพาะตอนสถานะเปลี่ยนจริง** — worker เดินทุกชั่วโมงและสภาพนี้นิ่ง
        // (คนจองห้องเองไว้แล้ว) ถ้าเขียนทุกรอบจะได้ audit ~48 แถว/วัน ต่อใบตลอดไป
        // และ `roomBookingAt` ถูกดันใหม่ทุกชั่วโมงจนอ่านเหมือนเพิ่งลองเมื่อกี้
        // (เจอจริงหลัง deploy v1.227: 14 แถวซ้ำใน 5 ชม. จาก 2 ใบ)
        const already = b.roomBookingStatus === 'SKIPPED'
          && b.roomBookingError === 'skip: manual-hold'
        if (!already) {
          await stamp(b.id, 'SKIPPED', null, 'manual-hold')
          logAudit({
            actorEmail: 'room-booking', action: 'booking.room_reserved', entityType: 'Booking',
            entityId: b.id, bookingCode: b.bookingCode,
            changes: {
              bookingNo: hold.bookingNo, manualHold: true,
              note: `คนของงานนี้จองห้องเองไว้แล้ว (${hold.bookedBy || '?'}) — ไม่ยิงซ้ำ`,
            },
          })
        }
        return { status: 'SKIPPED', reason: 'manual-hold' }
      }
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
              undefined, out.kind === 'ok' ? out.bookingNo : undefined,
              out.kind === 'ok' ? out.id : undefined)

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
  if (out.kind === 'conflict') {
    // v1.226 — "ห้องไม่ว่าง" ต้องเดินทางไปถึงคน และต้องบอกได้ว่าชนกับอะไร
    //
    // ระบบกลางตอบแค่ "ถูกจองแล้ว" ซึ่งทำอะไรต่อไม่ได้ · เคสจริง 29 ก.ย.:
    // TSS-GEB-260929-01 จองไม่ได้เพราะมีคนจอง Studio 1 ช่วงเดียวกัน **ด้วยมือ
    // ผ่านพอร์ทัล** ให้งานเดียวกันนั่นเอง — ห้องไม่ได้หายไปไหน แต่ไม่มีใครรู้
    // และ CONFLICT ก็นอนอยู่ใน DB เงียบ ๆ
    //
    // แจ้ง **เฉพาะตอนที่เพิ่งเปลี่ยนเป็น CONFLICT** ไม่ใช่ทุกรอบที่เห็นว่า CONFLICT
    // (worker เดินทุกชั่วโมง — แจ้งทุกรอบคือสแปมจนไม่มีใครอ่าน)
    //
    // 2026-11-08 — นี่คือเสียงเดียวของ CONFLICT แล้ว (reconcile ย้ายใบรอห้องออกจาก staleStuck
    // ไปไว้ conflictWaiting) และสถานะถูก stamp เป็น CONFLICT ไปแล้วข้างบน = รอบหน้าไม่แจ้งซ้ำ
    // ⇒ ห้ามหายเงียบ: อ่านเวลา/รายการชนไม่ได้ก็ยังโพสต์ (บอกว่าอ่านไม่ได้) และโพสต์ไม่ถึง → alertOps
    if (b.roomBookingStatus !== 'CONFLICT') {
      void notifyRoomConflict(code, b.locationName, roomId, built.payload, [b.producerEmail, b.createdByEmail])
    }
    return { status: 'CONFLICT', message: out.message }
  }
  if (out.kind === 'invalid') return { status: 'INVALID', message: out.message }
  return { status: 'UNKNOWN', message: out.message }
}

/**
 * แจ้งทีมว่าจองห้องไม่ได้ (เรียกครั้งเดียวตอนเพิ่งเปลี่ยนเป็น CONFLICT) — ไม่ throw
 * ส่งเข้าห้องทีมไม่ถึง / พังกลางทาง → alertOps('room-conflict:<code>') ให้ operator รู้แทน
 */
async function notifyRoomConflict(
  code: string,
  locationName: string | null | undefined,
  roomId: number,
  p: { startDate: string; startTime: string; endDate: string; endTime: string },
  /** โปรดิวเซอร์ + คนเปิดใบ — ใช้แยก "คนของงานนี้จองเองไว้ไม่ครบช่วง" ออกจาก "คนอื่นจอง" */
  ownerEmails: Array<string | null | undefined> = [],
): Promise<void> {
  const head = [
    `🚪 จองห้องให้ ${code} ไม่ได้ — ห้องไม่ว่าง`,
    `   ${locationName || ''} · ${p.startDate} ${p.startTime}–${p.endTime}`,
  ]
  let text = head.join('\n')
  try {
    // ช่วงเวลาที่เราขอไป = สิ่งที่ payload ส่งจริง (ไม่ประกอบใหม่ให้ต่างกัน)
    const startAt = bangkokToUtcIso(p.startDate, p.startTime)
    const endAt = bangkokToUtcIso(p.endDate, p.endTime)
    let detail: string[]
    if (!startAt || !endAt) {
      detail = ['   ⚠️ แปลงเวลาที่ขอไม่ได้ — บอกไม่ได้ว่าชนกับใคร']
    } else {
      try {
        const clashes = await describeRoomClash({ roomId, startAt, endAt })
        const manual = clashes.filter(c => !c.isProbook)
        // 2026-11-23 — คนของงานนี้จองเองแต่ไม่ครบช่วง (WLT-NGI-261116-01: 08:00–11:00 งานถึง 12:00) ห้ามบอกว่า
        // "ห้องได้แล้ว" — ต้องบอกว่าถือไว้ช่วงไหน ขาดช่วงไหน · ยังเป็น CONFLICT (ห้องขาดจริง)
        const own = ownHoldCoverage(clashes, { startAt, endAt }, ownerEmails)
        const spans = (xs: [string, string][]) => xs.map(([a, b]) => `${bkkTime(a)}–${bkkTime(b)}`).join(', ')
        detail = [
          ...(clashes.length ? ['   ชนกับ:'] : []),
          // ไม่ส่งหัวข้อการจองของคนอื่นออกไป — ชื่อคนจอง + เวลา พอให้ไปคุยต่อได้
          ...clashes.slice(0, 5).map(c =>
            `   • ${bkkTime(c.startAt)}–${bkkTime(c.endAt)} ${c.bookingNo} ${c.isProbook ? '(โปรบุ๊คจองเอง)' : `· จองมือโดย ${c.bookedBy || 'ไม่ทราบชื่อ'}${c.department ? ` (${c.department})` : ''}`}`),
          ...(own && own.missing.length
            ? [`   ⚠️ คนของงานนี้จองห้องเองไว้ ${spans(own.held)} แต่ขาด ${spans(own.missing)} — ` + (own.blocked
                ? 'ช่วงที่ขาดมีการจองอื่นอยู่ (ดูรายการข้างบน) — คุยกับคนจองหรือเปลี่ยนเวลา'
                : `ต่อเวลาในพอร์ทัล ${ROOM_BOOKING_BASE_URL}/booking`)]
            : manual.length ? ['   ⚠️ มีคนจองห้องนี้ด้วยมือในพอร์ทัล — ถ้าเป็นงานเดียวกัน ห้องได้แล้ว ไม่ต้องทำอะไร'] : []),
        ]
      } catch (e: any) {
        detail = [`   ⚠️ อ่านรายการที่ชนจากระบบกลางไม่ได้: ${e?.message || e}`]
      }
    }
    text = [...head, ...detail, '   ระบบจะลองใหม่อีกครั้งใน 6 ชม.'].join('\n')
    if (await notifyChat(text, 'footage')) return
    console.error(`[room-booking] conflict notice for ${code} not delivered to chat — falling back to alertOps`)
  } catch (e: any) {
    console.error(`[room-booking] conflict notify failed for ${code}:`, e?.message || e)
  }
  try {
    const r = await alertOps(`room-conflict:${code}`, `[probook] จองห้องไม่ได้ ${code} — แจ้งทีมไม่ถึง`,
      `${text}\n(ส่งเข้าห้องทีมไม่สำเร็จ — ส่งมาที่ ops แทน)`)
    if (r.attempted && !r.delivered) console.error(`[room-booking] conflict ${code}: ops alert not delivered either`)
  } catch (e: any) {
    console.error(`[room-booking] alertOps for conflict ${code} failed:`, e?.message || e)
  }
}

async function stamp(
  id: string,
  status: string,
  error: string | null,
  skipReason?: string,
  bookingNo?: string,
  ref?: number | null,
) {
  await prisma.booking.update({
    where: { id },
    data: {
      roomBookingStatus: status,
      roomBookingError: error || (skipReason ? `skip: ${skipReason}` : null),
      roomBookingAt: new Date(),
      ...(bookingNo ? { roomBookingNo: bookingNo } : {}),
      ...(ref !== undefined ? { roomBookingRef: ref } : {}),
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
    select: { id: true, bookingCode: true, shootDate: true, roomBookingNo: true, roomBookingRef: true },
  })
  if (!b?.bookingCode) return { status: 'NOT_FOUND' }

  // v1.206 — id ที่เก็บไว้ตอนจองมาก่อนเสมอ: ตรงตัว ไม่ต้องพึ่งการค้นปฏิทิน
  // (ค้นได้ทีละเดือน และอาศัย marker ใน title ซึ่งถ้าใครไปแก้ชื่อการจองก็หาไม่เจอ)
  let found: { id: number | null; bookingNo: string } | null =
    b.roomBookingRef != null ? { id: b.roomBookingRef, bookingNo: b.roomBookingNo || '' } : null

  const d = b.shootDate
  if (!found) {
    try {
      found = await findExistingRoomBooking(b.bookingCode, d.getUTCFullYear(), d.getUTCMonth() + 1)
    } catch (e: any) {
      return { status: 'UNKNOWN', message: `อ่านปฏิทินระบบกลางไม่สำเร็จ: ${e?.message || e}` }
    }
  }
  if (!found || found.id === null) {
    // ไม่มีอยู่แล้ว — ล้างสถานะฝั่งเราให้ตรงความจริง
    await prisma.booking.update({
      where: { id: b.id },
      data: { roomBookingNo: null, roomBookingRef: null, roomBookingStatus: 'SKIPPED', roomBookingError: 'ไม่พบการจองในระบบกลาง', roomBookingAt: new Date() },
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
      data: { roomBookingNo: null, roomBookingRef: null, roomBookingStatus: 'SKIPPED', roomBookingError: `ยกเลิกแล้ว (เดิม ${found.bookingNo})`, roomBookingAt: new Date() },
    })
    return { status: 'CANCELLED', bookingNo: found.bookingNo }
  }
  if (out.kind === 'not-found') return { status: 'NOT_FOUND' }
  if (out.kind === 'forbidden') return { status: 'FORBIDDEN', message: out.message }
  return { status: 'UNKNOWN', message: out.message }
}

/**
 * ฟิลด์ที่ตัดสินว่า "ห้องไหน ช่วงเวลาไหน" — เปลี่ยนตัวใดตัวหนึ่งแปลว่าการจองห้อง
 * ที่ยึดไว้อยู่ไม่ตรงกับตารางถ่ายอีกต่อไป
 *
 * v1.222 — ต้องอยู่ที่เดียว: เส้นทางแก้ใบจองมีหลายทาง (แอดมิน PATCH,
 * producer-edit, ...) และถ้าแต่ละทางเขียนเงื่อนไขเอง มันจะหลุดจากกันแบบเดียว
 * กับที่เคยเกิดกับกฎสิทธิ์และกฎ "ใครถูกแจ้ง"
 */
export interface RoomScheduleFields {
  shootDate?: Date | string | null
  shootEndDate?: Date | string | null
  callTime?: string | null
  estimatedWrap?: string | null
  locationId?: string | null
}

/** รายชื่อฟิลด์ที่เปลี่ยนไปจริง — ว่าง = ตารางเท่าเดิม ห้องเดิมยังใช้ได้ */
export function roomScheduleChanges(before: RoomScheduleFields, after: RoomScheduleFields): string[] {
  const norm = (v: Date | string | null | undefined): string => {
    if (v == null) return ''
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
    // Date ที่ถูก serialize มาแล้วต้องเทียบกับ Date ได้ ไม่ใช่ต่างกันเพราะรูปแบบ
    const t = Date.parse(v)
    return /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(t) ? new Date(t).toISOString() : String(v)
  }
  const keys: (keyof RoomScheduleFields)[] = ['shootDate', 'shootEndDate', 'callTime', 'estimatedWrap', 'locationId']
  return keys.filter(k => norm(before[k]) !== norm(after[k]))
}

/**
 * ตารางถ่ายเปลี่ยน → คืนห้องเดิม แล้วจองใหม่ให้ตรงตารางใหม่ — fire-and-forget
 *
 * v1.222 — ก่อนหน้านี้ "การแก้" ไม่เคยแตะห้องเลย: PATCH/producer-edit แก้เวลา
 * และสถานที่ได้ แล้ว re-sync ปฏิทิน + OT แต่ห้องถูกปล่อยค้างที่ช่วงเวลาเดิม
 * ตลอดไป ส่วนช่วงเวลาใหม่ไม่มีห้อง และไม่มีใครรู้จนถึงวันถ่าย
 *
 * **ลำดับสำคัญ**: ต้องคืนห้องเดิมให้สำเร็จ *ก่อน* ถึงจะจองใหม่ ไม่งั้นใบเดียว
 * จะยึดห้องสองช่วง — และถ้าคืนไม่สำเร็จ (ระบบเขาล่ม/ไม่มีสิทธิ์) ต้อง **ไม่จองใหม่**
 * ปล่อยให้ตัวคืนสภาพรอบชั่วโมงมาเก็บ ซึ่งตอนนี้มันเทียบห้อง+เวลากับของจริงได้แล้ว
 */
/** สถานะชั่วคราวระหว่าง resync — ใช้เป็นตัวจองสิทธิ์ ไม่ใช่ผลลัพธ์จริง */
const RESYNC_MARK = 'RESYNCING'
/** ถือ mark ค้างได้นานสุดเท่านี้ก่อนให้คนอื่นแย่งไปทำต่อ (กัน process ตายคาที่) */
const RESYNC_STALE_MS = 10 * 60 * 1000

export function resyncRoomForBooking(bookingId: string, reason: string): void {
  void (async () => {
    try {
      const b = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          roomBookingNo: true, bookingCode: true, status: true, deletedAt: true,
          roomBookingStatus: true, roomBookingError: true, locationName: true, shootType: true,
        },
      })
      if (!b || b.deletedAt || b.status === 'CANCELLED') return  // เส้นทางยกเลิกดูแลอยู่แล้ว
      // ไม่มีห้องให้คืน — ปกติปล่อยให้เส้นทางจองปกติ (reconcile รายชั่วโมง) ทำงาน ยกเว้นสองสถานะที่ reconcile ไม่แตะทันที
      if (!b.roomBookingNo) {
        await retryUnbookedNow(bookingId, b, reason)
        return
      }

      // review fix — กันซ้อนต่อใบจอง: คนกดบันทึกรัว ๆ หรือ resync ชนกับตัวคืนสภาพ
      // รายชั่วโมง จะได้ "คืนห้องสองครั้ง จองใหม่สองครั้ง" ในระบบที่ไม่มี idempotency
      //
      // ใช้ UPDATE เดียวเป็นตัวจอง (atomic) ไม่ใช่ advisory lock — lock แบบ xact
      // จะถูกปล่อยทันทีที่ transaction commit ซึ่งเกิดก่อนงาน HTTP จะเริ่มด้วยซ้ำ
      // จึงกันอะไรไม่ได้จริง (และเรียก HTTP คาไว้ใน transaction ก็ไม่ควรทำ)
      //
      // เงื่อนไข `roomBookingStatus != RESYNCING` คือตัวกั้น ส่วน roomBookingAt
      // ที่เก่าเกิน STALE คือทางออกเผื่อ process ตายคาระหว่างทาง — บทเรียนเดียวกับ
      // v1.149 ที่ guard แบบ boolean เคยล็อกค้างจนงานรอบกลางคืนเงียบไปทั้งชุด
      const claimed = await prisma.booking.updateMany({
        where: {
          id: bookingId,
          roomBookingNo: b.roomBookingNo,
          OR: [
            { roomBookingStatus: { not: RESYNC_MARK } },
            { roomBookingAt: { lt: new Date(Date.now() - RESYNC_STALE_MS) } },
          ],
        },
        data: { roomBookingStatus: RESYNC_MARK, roomBookingAt: new Date() },
      })
      if (claimed.count === 0) {
        console.warn(`[room-booking] resync ซ้อน ${b.bookingCode} — ข้ามรอบนี้ (${reason})`)
        return
      }

      const r = await cancelRoomBookingFor(bookingId)
      if (r.status !== 'CANCELLED' && r.status !== 'NOT_FOUND') {
        console.warn(`[room-booking] ตารางเปลี่ยนแต่คืนห้องไม่สำเร็จ ${b.bookingCode} (${reason}):`, r)
        logAudit({
          actorEmail: 'room-booking', action: 'booking.room_release_failed',
          entityType: 'Booking', entityId: bookingId, bookingCode: b.bookingCode,
          changes: { reason, ...r, note: 'ยังไม่จองใหม่ — รอตัวคืนสภาพ' },
        })
        return
      }

      const s = await syncRoomBooking(bookingId)
      logAudit({
        actorEmail: 'room-booking', action: 'booking.room_resynced',
        entityType: 'Booking', entityId: bookingId, bookingCode: b.bookingCode,
        changes: { reason, released: r.status, rebooked: s.status, ...('bookingNo' in s ? { bookingNo: s.bookingNo } : {}), ...('message' in s ? { message: s.message } : {}) },
      })
      // 2026-11-23 — ห้องเดิมคืนไปแล้ว แต่ตารางใหม่ประกอบเป็นห้อง/เวลาไม่ได้ = ใบนี้ไม่มีห้อง และไม่มีอะไรจองให้
      // (TSS-SCI-261209-01: แก้สถานที่เป็น 'Studio 2 (TSD)' พิมพ์เอง → BK-0555 ถูกคืน → SKIPPED no-location เงียบทุกชั้น)
      // v1.291 review — same key + 24 h as the reconciler's 'room-unresolved' (STUDIO only, like it), so an edit that
      // loses the room alerts once at once and the hourly reconciler does not alert the same thing again.
      if (s.status === 'SKIPPED' && UNRESOLVED_SKIPS.has(s.reason) && b.shootType === 'STUDIO') {
        const code = b.bookingCode || bookingId
        const a = await alertOps(`room-unresolved:${code}`, `[probook] ${code} ห้องเดิมถูกคืนแล้ว แต่ตารางใหม่จองห้องไม่ได้`,
          `🚪 ${code} ห้องเดิม${r.status === 'CANCELLED' ? ` (${r.bookingNo})` : ''} ถูกคืนแล้วหลังแก้ใบ (${reason})\n` +
          `   แต่ตารางใหม่จองห้องไม่ได้: ${unresolvedRoomText(s.reason, b.locationName)}\n` +
          `   ใบนี้ไม่มีห้อง — แก้ใบให้เลือกห้องจากรายการ / กรอกเวลาให้ครบ หรือจองมือที่ ${ROOM_BOOKING_BASE_URL}/booking`,
          24 * 3_600_000)
        if (a.attempted && !a.delivered) console.error(`[room-booking] room-lost ${code}: ops alert reached no channel`)
      }
    } catch (e: any) {
      console.error('[room-booking] resyncRoomForBooking error:', e?.message || e)
    }
  })()
}

/**
 * 2026-11-23 — ใบที่ยังไม่มีห้องเพราะ **ห้องไม่ว่าง (CONFLICT)** หรือ **คนของงานจองมือไว้ (manual-hold)** แล้วเจ้าของแก้
 * ห้อง/เวลา: เดิม resync ออกทันที (ไม่มีเลขให้คืน) และ reconcile ข้าม CONFLICT ที่ยังไม่ครบ 6 ชม. ⇒ ตารางใหม่ที่ว่างแล้ว
 * ต้องรอถึง 6 ชม. ถึงจะได้ห้อง · การจองมือที่ไม่ครอบเวลาใหม่ก็ไม่มีใครรู้จนกว่า reconcile จะวนมา
 * → ลองทันทีผ่าน syncRoomBooking (อ่านกลับก่อนยิงเสมอ ไม่จองซ้ำ และ stamp roomBookingAt ใหม่)
 * จองสิทธิ์ด้วย UPDATE เดียวแบบเส้นหลัก (RESYNCING) — กดบันทึกรัวสองครั้ง = POST สองครั้ง = จองซ้ำ ในระบบที่ไม่มี idempotency
 * สถานะอื่น (SKIPPED อื่น ๆ / UNKNOWN / ไม่มีสถานะ) reconcile รายชั่วโมงหยิบเองอยู่แล้ว
 */
async function retryUnbookedNow(
  bookingId: string,
  b: { bookingCode: string | null; roomBookingStatus: string | null; roomBookingError: string | null },
  reason: string,
): Promise<void> {
  // v1.291 review — INVALID too: the reconciler spaces INVALID 6 h, so a producer who fixes the data would wait that long
  const retry = b.roomBookingStatus === 'CONFLICT' || b.roomBookingStatus === 'INVALID'
    || (b.roomBookingStatus === 'SKIPPED' && b.roomBookingError === 'skip: manual-hold')
  if (!retry || !roomBookingEnabled()) return
  const claimed = await prisma.booking.updateMany({
    where: { id: bookingId, roomBookingNo: null, roomBookingStatus: b.roomBookingStatus, roomBookingError: b.roomBookingError },
    data: { roomBookingStatus: RESYNC_MARK, roomBookingAt: new Date() },
  })
  if (claimed.count === 0) {
    console.warn(`[room-booking] resync ซ้อน ${b.bookingCode} — ข้ามรอบนี้ (${reason})`)
    return
  }
  const s = await syncRoomBooking(bookingId)
  logAudit({
    actorEmail: 'room-booking', action: 'booking.room_resynced',
    entityType: 'Booking', entityId: bookingId, bookingCode: b.bookingCode,
    changes: { reason, released: 'NONE', was: b.roomBookingStatus, rebooked: s.status,
      ...('bookingNo' in s ? { bookingNo: s.bookingNo } : {}), ...('message' in s ? { message: s.message } : {}) },
  })
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
        select: { ...ROOM_BOOKING_SELECT, roomBookingNo: true, roomBookingError: true },
      })
      if (!b) return
      if (!b.roomBookingNo) {
        if (b.roomBookingError === 'skip: manual-hold') await warnManualHoldLeft(b, reason)
        return
      }
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

/**
 * 2026-11-23 — ใบที่ห้องเป็นการจองมือของคนของงาน (manual-hold) ถูกยกเลิก/ลบ: ฝั่งเราไม่มีเลขห้อง และ service key
 * ยกเลิกของคนอื่นไม่ได้ (403) ⇒ เดิมออกเงียบ ห้องค้างให้คิวที่ตายแล้ว (BK-0404 War Room 26 พ.ย. ของ KND-KNF-261126-01)
 * บอก operator ทาง alertOps (ไม่ใช่ห้องทีม) — **ต่อเมื่ออ่านระบบกลางแล้วเจอการจองมือนั้นจริง** พร้อมเลข BK
 * ห้ามยืนยันลอย ๆ: เจ้าของอาจยกเลิกไปแล้ว หรือที่ "ถือไว้" คือห้องที่โปรบุ๊คจองให้งานอื่นของคนเดียวกัน
 * (findManualHold v1.227.3 นับรวม) ซึ่งยังใช้อยู่ — ไปตามให้ยกเลิก = ไปปลดห้องของงานที่ยังมีชีวิต
 * ถ่ายไปแล้ว = ไม่มีอะไรให้คืน · อ่านไม่ได้ = เตือนให้ตรวจเอง (ไม่เงียบ)
 * ponytail: 1 GET ต่อใบ — ยกเลิก routine ทั้งกลุ่มที่เป็น manual-hold หลายใบจะยิงพร้อมกัน (ทั้งประวัติมี manual-hold 7 ใบ)
 */
async function warnManualHoldLeft(
  b: Parameters<typeof buildPayloadForBooking>[0] & { locationName: string | null; createdByEmail: string | null },
  reason: string,
): Promise<void> {
  const code = b.bookingCode || b.id
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  if (ymd(b.shootEndDate ?? b.shootDate) < ymd(new Date(Date.now() + 7 * 3_600_000))) return
  const where = `${b.locationName || '?'} ${ymd(b.shootDate)} ${b.callTime || '?'}–${b.estimatedWrap || '?'}`
  let what: string
  try {
    const built = buildPayloadForBooking(b)
    if (!('payload' in built)) throw new Error('ประกอบห้อง/ช่วงเวลาของใบนี้ไม่ได้')
    const p = built.payload
    const startAt = bangkokToUtcIso(p.startDate, p.startTime)
    const endAt = bangkokToUtcIso(p.endDate, p.endTime)
    if (!startAt || !endAt) throw new Error('แปลงเวลาถ่ายไม่ได้')
    const marker = roomBookingMarker(code)
    const month = await listRoomBookings(b.shootDate.getUTCFullYear(), b.shootDate.getUTCMonth() + 1)
    const left = ownRoomRows(month, p.roomId, [b.producerEmail, b.createdByEmail], marker, [p.title.replace(marker, '').trim()])
      .filter(r => !r.isProbook && overlaps(startAt, endAt, r.startAt!, r.endAt!))
    if (!left.length) return   // ยกเลิกไปแล้ว / ที่ถือไว้คือห้องที่โปรบุ๊คจองให้งานอื่น — ไม่มีอะไรต้องตาม
    what = `ห้องที่คนของงานจองมือไว้ยังอยู่ในระบบกลาง: ` +
      left.map(r => `${r.bookingNo} ${bkkTime(r.startAt)}–${bkkTime(r.endAt)} โดย ${r.bookedBy || '?'}`).join(', ') +
      ` (${where}) — เจ้าของต้องยกเลิกเอง`
  } catch (e: any) {
    what = `ตรวจไม่ได้ว่าห้องที่คนของงานจองมือไว้ (${where}) ยังค้างไหม: ${e?.message || e} — ตรวจในพอร์ทัล`
  }
  const a = await alertOps(`room-manual-hold-left:${code}`,
    `[probook] ${code} ยกเลิกแล้ว — ห้องที่จองมือไว้อาจยังค้างในระบบกลาง`,
    `🚪 ${code} ยกเลิกแล้ว แต่${what}\n   ${ROOM_BOOKING_BASE_URL}/booking (${reason})`)
  if (a.attempted && !a.delivered) console.error(`[room-booking] manual-hold left for ${code}: ops alert reached no channel`)
}
