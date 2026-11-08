/**
 * v1.244 — GET /api/mix/candidates — "งานของฉัน" ให้เลือกขอมิกซ์โดยไม่ต้องจำรหัส
 *
 * ขอบเขต "ของฉัน" มาจาก myBookingsWhere ที่เดียว (คนสร้าง / Producer / Co-Producer / ทีมในงาน)
 * — บทเรียน v1.196: นิยาม "ของฉัน" ที่ก็อปไปหลายที่คือเหตุที่โปรดิวเซอร์มองไม่เห็นงานตัวเอง 59 ใบ
 *
 * ช่วงเวลา: ถ่ายไปแล้วไม่เกิน 45 วัน ถึงอีก 60 วันข้างหน้า — งานมิกซ์เกิดหลังถ่าย แต่คนจอง
 * ล่วงหน้าได้ · ใบยกเลิก/ลบไม่เอา
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { myBookingsWhere, assignedBookingIdsCI } from '@/lib/my-bookings-scope'
import { MIX_TARGET_SELECT, toMixTargetView, openMixJobsFor } from '@/lib/mix-targets'

export const dynamic = 'force-dynamic'

const PAST_DAYS = 45
const FUTURE_DAYS = 60
const LIMIT = 60

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const now = Date.now()
    const base = {
      ...myBookingsWhere(session.email, await assignedBookingIdsCI(session.email)),
      deletedAt: null,
      status: { not: 'CANCELLED' as const },
    }
    // งานที่ถ่ายแล้วก่อน (ใหม่→เก่า) แล้วค่อยเติมงานข้างหน้าที่ใกล้สุด — เดิมเรียง desc ทั้งช่วง
    // แล้ว take 60 = เก็บงานไกลสุดในอนาคตไว้ก่อน และตัดงานที่ถ่ายไปแล้ว 18–45 วัน (ที่ต้องมิกซ์จริง)
    // ทิ้งก่อน · รูปเดียวกับบั๊ก footage-integrity v1.233 (docs/bug-classes.md คลาส 4)
    const [past, future] = await Promise.all([
      prisma.booking.findMany({
        where: { ...base, shootDate: { gte: new Date(now - PAST_DAYS * 86_400_000), lte: new Date(now) } },
        select: MIX_TARGET_SELECT,
        orderBy: { shootDate: 'desc' },
        take: LIMIT + 1,
      }),
      prisma.booking.findMany({
        where: { ...base, shootDate: { gt: new Date(now), lte: new Date(now + FUTURE_DAYS * 86_400_000) } },
        select: MIX_TARGET_SELECT,
        orderBy: { shootDate: 'asc' },
        take: LIMIT + 1,
      }),
    ])
    const rows = [...past, ...future].slice(0, LIMIT)
      .sort((a, b) => b.shootDate.getTime() - a.shootDate.getTime()) // หน้าจอเรียงใหม่→เก่าเหมือนเดิม
    const openJobs = await openMixJobsFor(rows.map(r => r.id))
    return NextResponse.json({
      bookings: rows.map(toMixTargetView),
      openJobs,
      // บอกตรง ๆ ว่าตัดที่เพดาน — ลิสต์ที่ถูกตัดเงียบ ๆ ทำให้คนคิดว่างานตัวเองหายไป
      // (ดึงเกินมา 1 ใบต่อฝั่ง = รู้จริงว่าตัด ไม่ใช่เดาจาก length === LIMIT)
      truncated: past.length + future.length > LIMIT,
      window: { pastDays: PAST_DAYS, futureDays: FUTURE_DAYS },
    })
  } catch (e) {
    console.error('GET /api/mix/candidates error:', e)
    return NextResponse.json({ error: 'โหลดงานของคุณไม่สำเร็จ' }, { status: 500 })
  }
}
