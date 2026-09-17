import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { checkRoomAvailability } from '@/lib/room-availability'

export const dynamic = 'force-dynamic'

/**
 * POST /api/room-availability
 * { locationId, shootDate, shootEndDate?, callTime, estimatedWrap?, excludeBookingId? }
 *
 * v1.223 — "ห้องนี้มีใครจองคาบเกี่ยวอยู่ไหม" สำหรับฟอร์มจองคิว
 *
 * ทำไมฟอร์มต้องยิงมาที่นี่ ไม่ยิง service.thestandard.co เอง:
 *   - rate limit ของเขาคือ 20 req/5 นาที **ต่อ IP** ซึ่งทั้งบริษัทใช้ร่วมกัน
 *     ถ้าปล่อยให้ยิงตามการพิมพ์ โควตาจะหมดจนงานจองห้องจริงของ worker ล้ม
 *   - ต้องตัด title/email/department ของแผนกอื่นทิ้งก่อนส่งออก (ทำที่ server เท่านั้น)
 *   - ฟีดของเขาไม่มี CORS header ให้อยู่แล้ว
 *
 * คำเตือนเรื่องเดียวกับ v1.177: **แนะนำ ไม่ห้าม** — endpoint นี้ไม่เคยปฏิเสธการจอง
 * และ error ต้องเดินทางไปถึงผู้ใช้ ไม่ใช่กลืนเงียบแล้วดูเหมือน "ไม่มีอะไรต้องเตือน"
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const { locationId, shootDate, shootEndDate, callTime, estimatedWrap, excludeBookingId } = body || {}
    if (!shootDate) return NextResponse.json({ error: 'shootDate required' }, { status: 400 })

    const result = await checkRoomAvailability({
      locationId, shootDate, shootEndDate, callTime, estimatedWrap, excludeBookingId,
    })
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('POST /api/room-availability error:', e?.message || e)
    // 500 พร้อมเหตุผล — ฝั่งหน้าเว็บจะได้แสดงว่า "ตรวจไม่ได้" ไม่ใช่เงียบ
    return NextResponse.json(
      { state: 'unknown', reason: 'ตรวจห้องไม่สำเร็จ — ลองใหม่อีกครั้ง' },
      { status: 500 },
    )
  }
}
