import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { cancelRoomBookingFor } from '@/lib/room-booking-sync'

export const dynamic = 'force-dynamic'

/** audit ของการจองห้อง — ห้ามลบทิ้งพร้อมใบจอง (ดูเหตุผลใน transaction ข้างล่าง) */
const ROOM_AUDIT_ACTIONS = [
  'booking.room_reserved', 'booking.room_cancelled',
  'booking.room_release_failed', 'booking.room_vanished', 'booking.room_resynced',
]

/**
 * POST /api/admin/[id]/delete
 * Hard-deletes a booking and all related records. ADMIN only.
 * Episodes + uploads cascade automatically (onDelete: Cascade).
 * Audit logs, footage_log, and auto-generated ot_records rows referencing
 * this booking are cleaned up explicitly (no FK cascade on those tables).
 * The Google Calendar event is deleted best-effort.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = params

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, bookingCode: true, status: true, calendarEventId: true,
      // v1.222 — ต้องติดไปกับ audit หลังลบ เพราะหลังจากนี้ไม่เหลือที่ไหนให้ค้นอีก
      roomBookingNo: true, roomBookingRef: true, roomBookingStatus: true, shootDate: true,
      outlet: { select: { name: true } }, program: { select: { name: true } } },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Best-effort: delete calendar event if it exists
  if (booking.calendarEventId) {
    deleteCalendarEvent(booking.calendarEventId).catch(e =>
      console.warn(`[delete-booking] calendar event delete failed: ${e}`)
    )
  }

  // Clean up audit_logs, footage_log, and auto-OT rows that reference this
  // booking (no FK cascade on those tables). Manual OT entries have
  // bookingId = null and are untouched.
  // v1.222 — คืนห้อง **ก่อน** ลบแถว: หลังจากนี้ไม่มี roomBookingNo/Ref เหลืออยู่
  // ในระบบเลย ตัวคืนสภาพอ่านจากตาราง Booking จึงตามเก็บไม่ได้ตลอดกาล
  //
  // review fix — `cancelRoomBookingFor` **ไม่ throw** เวลาคืนไม่สำเร็จ มันคืนค่า
  // ปกติเป็น FORBIDDEN/UNKNOWN (timeout, 502, ระบบเขาล่ม) ⇒ try/catch เปล่า ๆ
  // ไม่มีวันทำงาน แล้วโค้ดก็ไหลไปลบแถวทิ้งพร้อมเบาะแสทั้งหมด
  // ⇒ fail-closed: คืนไม่สำเร็จ = **ไม่ลบ** ใบยังเป็น soft-deleted อยู่ ตัวคืนสภาพ
  //   รายชั่วโมงจึงยังตามเก็บและเตือนต่อได้ ผู้ใช้กดลบซ้ำได้เมื่อระบบเขากลับมา
  if (booking.roomBookingNo) {
    let r: Awaited<ReturnType<typeof cancelRoomBookingFor>>
    try {
      r = await cancelRoomBookingFor(id)
    } catch (e: any) {
      r = { status: 'UNKNOWN', message: e?.message || String(e) }
    }
    if (r.status !== 'CANCELLED' && r.status !== 'NOT_FOUND') {
      return NextResponse.json({
        error: 'ยังลบไม่ได้ — คืนห้องในระบบกลางไม่สำเร็จ',
        detail: r.message,
        roomBookingNo: booking.roomBookingNo,
        roomBookingRef: booking.roomBookingRef,
        hint: `ลบแถวตอนนี้จะทำให้ห้อง ${booking.roomBookingNo} ถูกยึดค้างโดยไม่มีอะไรชี้กลับมาได้ — ลองใหม่เมื่อ service.thestandard.co กลับมา หรือไปยกเลิกด้วยมือก่อน`,
      }, { status: 409 })
    }
  }

  await prisma.$transaction([
    // v1.222 — เก็บ audit ของ "ห้อง" ไว้เสมอ: ถ้ามีอะไรพลาดจนห้องค้างในระบบเขา
    // แถวพวกนี้คือที่เดียวที่ยังบอกเลข BK-#### ได้ หลังแถว Booking หายไปแล้ว
    prisma.auditLog.deleteMany({
      where: { entityId: id, action: { notIn: ROOM_AUDIT_ACTIONS } },
    }),
    prisma.footageLog.deleteMany({ where: { bookingId: id } }),
    prisma.oTRecord.deleteMany({ where: { bookingId: id } }),
    prisma.booking.delete({ where: { id } }), // cascades episodes + uploads
  ])

  // Write a post-delete audit entry so we have a trail
  await logAudit({
    actorEmail: session.email,
    action: 'admin.delete_booking',
    entityType: 'booking',
    entityId: id,
    changes: {
      bookingCode: booking.bookingCode,
      status: booking.status,
      outlet: booking.outlet?.name,
      program: booking.program?.name,
    },
  })

  return NextResponse.json({ ok: true })
}
