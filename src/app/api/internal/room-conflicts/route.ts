import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { prisma } from '@/lib/db'
import { roomTargetForBooking, findRoomConflict, roomIdForLocation } from '@/lib/room-booking'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/room-conflicts[?days=30]
 *
 * v1.195 (เฟส 2) — อ่านอย่างเดียว ไม่เขียนอะไรทั้งสิ้น: เอาคิวถ่ายที่จะถึงของโปรบุ๊ค
 * ไปเทียบกับตารางห้องในระบบกลาง `service.thestandard.co` แล้วบอกว่าห้องชนไหม
 *
 * มีไว้สองอย่าง: (1) ให้เห็นว่าห้องชนกันจริงบ่อยแค่ไหนก่อนตัดสินใจทำเฟส 3
 * (2) พิสูจน์ว่าโซ่ทั้งเส้น (locationId → roomId → เวลา UTC → API เขา) ถูกต้อง
 * กับข้อมูลจริง ก่อนที่จะเอาไปใช้ตัดสินใจ "เขียน"
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-room-conflicts-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const days = Math.min(120, Math.max(1, parseInt(searchParams.get('days') || '30', 10) || 30))

  const today = new Date()
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const to = new Date(from.getTime() + days * 86_400_000)

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: ['REQUESTED', 'CONFIRMED'] },
      shootDate: { gte: from, lt: to },
    },
    select: {
      id: true, bookingCode: true, locationId: true, locationName: true,
      shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
    },
    orderBy: { shootDate: 'asc' },
  })

  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const skipped: Record<string, number> = {}
  const checked: any[] = []
  const conflicts: any[] = []
  const errors: { code: string | null; error: string }[] = []

  for (const b of bookings) {
    const r = roomTargetForBooking({
      locationId: b.locationId,
      shootDate: ymd(b.shootDate),
      shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
      callTime: b.callTime,
      estimatedWrap: b.estimatedWrap,
    })
    if ('skip' in r) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; continue }
    try {
      const hit = await findRoomConflict(r.target)
      const row = {
        code: b.bookingCode, room: b.locationName, roomId: r.target.roomId,
        startAt: r.target.startAt, endAt: r.target.endAt,
      }
      checked.push(row)
      if (hit) conflicts.push({ ...row, conflictsWith: hit })
    } catch (e: any) {
      errors.push({ code: b.bookingCode, error: e?.message || String(e) })
    }
  }

  return NextResponse.json({
    windowDays: days,
    bookingsInWindow: bookings.length,
    checkedAgainstCentralSystem: checked.length,
    skipped,
    conflicts,
    errors,
    note: 'อ่านอย่างเดียว ไม่ได้จองอะไรในระบบกลาง — การจองจริงคือเฟส 3 ซึ่งต้องมี credential จาก IT',
  })
}
