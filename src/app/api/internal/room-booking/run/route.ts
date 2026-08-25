import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { prisma } from '@/lib/db'
import { syncRoomBooking, cancelRoomBookingFor } from '@/lib/room-booking-sync'
import { roomTargetForBooking, roomIdForLocation, buildRoomBookingPayload, roomBookingEnabled } from '@/lib/room-booking'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/room-booking/run[?dryRun=1][&codes=A,B][&days=30][&max=5]
 *
 * v1.200 — จองห้องในระบบกลางให้คิวที่ยังไม่ได้จอง
 *
 * `dryRun=1` (ค่าเริ่มต้น) = **ไม่ยิงอะไรเลย** แค่บอกว่าจะส่ง payload อะไรไปบ้าง
 * ต้องใส่ `dryRun=0` ถึงจะจองจริง — ตั้งใจให้ default ปลอดภัย เพราะปลายทางเป็น
 * ระบบของทีมอื่นที่ไม่มี idempotency และการจองจะเด้งเข้ากลุ่ม LINE ของแอดมินเขา
 *
 * `max` จำกัดจำนวนต่อรอบ (ค่าเริ่มต้น 5) — rate limit ของเขาคือ 20 req/5 นาทีต่อ IP
 * และการอ่านกลับก่อนยิงกินอีก 1 request ต่อใบ
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-room-booking-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const sp = new URL(request.url).searchParams
  const dryRun = sp.get('dryRun') !== '0'
  // ?cancel=CODE — ยกเลิกการจองห้องของใบนั้นในระบบกลาง (ต้องใส่ dryRun=0 ด้วย)
  const cancelCode = (sp.get('cancel') || '').trim()
  const days = Math.min(120, Math.max(1, parseInt(sp.get('days') || '30', 10) || 30))
  const max = Math.min(20, Math.max(1, parseInt(sp.get('max') || '5', 10) || 5))
  const codes = (sp.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 25)

  if (cancelCode) {
    if (dryRun) {
      return NextResponse.json({ dryRun: true, wouldCancel: cancelCode, note: 'ใส่ dryRun=0 เพื่อยกเลิกจริง' })
    }
    const row = await prisma.booking.findFirst({
      where: { bookingCode: cancelCode, deletedAt: null },
      select: { id: true, bookingCode: true },
    })
    if (!row) return NextResponse.json({ error: `ไม่พบใบจอง ${cancelCode}` }, { status: 404 })
    const r = await cancelRoomBookingFor(row.id)
    return NextResponse.json({ dryRun: false, cancel: cancelCode, ...r })
  }

  const today = new Date()
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const to = new Date(from.getTime() + days * 86_400_000)

  const candidates = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      roomBookingNo: null,
      // สั่งเจาะจงรหัส = "เอาใบนี้แหละ" จึงไม่กรองสถานะ (ยกเว้นที่ยกเลิกไปแล้ว)
      // — ใช้ตอนทดสอบกับงานที่จบไปแล้ว หรือตามเก็บใบที่ตกหล่น
      // ส่วนการกวาดตามช่วงวันยังจำกัดที่ CONFIRMED เหมือนเดิม
      ...(codes.length > 0
        ? { bookingCode: { in: codes }, status: { not: 'CANCELLED' } }
        : { status: 'CONFIRMED', shootDate: { gte: from, lt: to } }),
    },
    select: {
      id: true, bookingCode: true, locationId: true, locationName: true,
      shootDate: true, shootEndDate: true, callTime: true, estimatedWrap: true,
      producer: true, producerEmail: true, roomBookingStatus: true,
      outlet: { select: { code: true, name: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, title: true } },
    },
    orderBy: { shootDate: 'asc' },
  })

  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const plan: any[] = []
  const skipped: Record<string, number> = {}

  for (const b of candidates) {
    const t = roomTargetForBooking({
      locationId: b.locationId, shootDate: ymd(b.shootDate),
      shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
      callTime: b.callTime, estimatedWrap: b.estimatedWrap,
    })
    if ('skip' in t) { skipped[t.skip] = (skipped[t.skip] || 0) + 1; continue }
    const roomId = roomIdForLocation(b.locationId)!
    const built = buildRoomBookingPayload({
      roomId, bookingCode: b.bookingCode || b.id,
      showName: [b.outlet.code, b.episodes[0]?.title?.trim() || b.program.name].filter(Boolean).join(' · '),
      shootDate: ymd(b.shootDate), shootEndDate: b.shootEndDate ? ymd(b.shootEndDate) : null,
      callTime: b.callTime, estimatedWrap: b.estimatedWrap,
      producerName: b.producer, producerEmail: b.producerEmail,
      department: b.outlet.name, notes: b.episodes.map(e => e.episodeId).join(', '),
    })
    if ('error' in built) {
      plan.push({ code: b.bookingCode, room: b.locationName, blocked: built.error })
      continue
    }
    plan.push({ code: b.bookingCode, room: b.locationName, payload: built.payload })
  }

  const ready = plan.filter(p => p.payload)
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      enabled: roomBookingEnabled(),
      candidates: candidates.length,
      skipped,
      blocked: plan.filter(p => p.blocked),
      wouldBook: ready.slice(0, max),
      wouldBookTotal: ready.length,
      note: 'ยังไม่ได้ยิงอะไรเลย — ใส่ dryRun=0 เพื่อจองจริง (max จำกัดต่อรอบ)',
    })
  }

  const results: any[] = []
  for (const p of ready.slice(0, max)) {
    const row = candidates.find(c => c.bookingCode === p.code)!
    // force=true: endpoint นี้เป็นการสั่งด้วยมือ จึงไม่ต้องรอ flag ระดับระบบ
    const r = await syncRoomBooking(row.id, { force: true })
    results.push({ code: p.code, ...r })
    // เว้นจังหวะเล็กน้อย — rate limit 20 req/5 นาทีต่อ IP และแต่ละใบกิน 2 request
    await new Promise(res => setTimeout(res, 1200))
  }

  return NextResponse.json({
    dryRun: false,
    attempted: results.length,
    remaining: Math.max(0, ready.length - results.length),
    results,
  })
}
