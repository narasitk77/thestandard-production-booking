import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { prisma } from '@/lib/db'
import { syncBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/ot/resync?month=YYYY-MM[&dryRun=1]
 *
 * v1.193 — สร้างร่าง OT ของเดือนหนึ่งขึ้นใหม่จากคิวถ่ายที่มีอยู่.
 *
 * ทำไมต้องมี: ร่าง OT เป็น "ข้อมูลอนุพันธ์" ทั้งใบ (ทุกช่องคำนวณจากใบจอง —
 * ดู src/lib/ot-sync.ts) มันถูกสร้างตอน approve/assign/แก้เวลา เท่านั้น
 * ฉะนั้นถ้ามันหายไปด้วยเหตุใดก็ตาม ก็ไม่มีทางกลับมาจนกว่าจะมีคนไปแตะใบจองนั้น
 * อีกครั้ง — ซึ่งงานที่อนุมัติแล้วไม่มีเหตุให้แตะ. บั๊ก cleanupOTRecords (แก้ใน
 * v1.192) ลบร่างของเดือนถัดไปทิ้งทุกครั้งที่มีคนเปิดหน้า /ot ทำให้ร่างเดือน
 * ก.ย. 2026 หายทั้งเดือน และไม่มีเครื่องมือใดกู้คืนได้เลย
 *
 * ปลอดภัยที่จะรันซ้ำ: syncBookingOT ลบ-แล้ว-สร้างใหม่ต่อใบจอง และไม่แตะใบที่
 * ไม่มีคิวถ่ายรองรับ. แต่ "ลบ-แล้ว-สร้างใหม่" แปลว่าถ้ามีคนแก้ร่างด้วยมือไว้
 * การแก้นั้นจะหาย — จึงข้ามใบที่ไม่ใช่ DRAFT ทิ้งไว้เฉย ๆ
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-ot-resync-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const month = (searchParams.get('month') || '').trim()
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
  }

  const [y, m] = month.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      shootDate: { gte: start, lt: end },
      // callTime เป็น String ไม่ nullable ในสคีมา — ค่าว่างคือ "ยังไม่มีเวลา"
      callTime: { not: '' },
    },
    select: { id: true, bookingCode: true, assignedEmails: true, shootDate: true },
    orderBy: { shootDate: 'asc' },
  })

  // ใบที่มีร่างอยู่แล้วไม่ต้องยุ่ง — และถ้าร่างถูกส่ง/อนุมัติไปแล้ว ห้ามยุ่งเด็ดขาด
  const existing = await prisma.oTRecord.findMany({
    where: { month, bookingId: { in: bookings.map(b => b.id) } },
    select: { bookingId: true, approvalStatus: true },
  })
  const hasRows = new Set(existing.map(r => r.bookingId).filter((x): x is string => !!x))
  const locked = new Set(
    existing.filter(r => r.approvalStatus !== 'DRAFT')
      .map(r => r.bookingId).filter((x): x is string => !!x),
  )

  const candidates = bookings.filter(b =>
    (b.assignedEmails || []).length > 0 && !hasRows.has(b.id) && !locked.has(b.id))

  if (dryRun) {
    return NextResponse.json({
      month, dryRun: true,
      bookingsInMonth: bookings.length,
      alreadyHaveRows: hasRows.size,
      lockedNonDraft: locked.size,
      wouldSync: candidates.map(b => b.bookingCode || b.id),
    })
  }

  let created = 0
  const synced: string[] = []
  const failed: string[] = []
  for (const b of candidates) {
    try {
      const r = await syncBookingOT(b.id)
      created += r.created
      if (r.created > 0) synced.push(b.bookingCode || b.id)
    } catch {
      failed.push(b.bookingCode || b.id)
    }
  }

  logAudit({
    actorEmail: 'ot-resync',
    action: 'ot.resync',
    entityType: 'OTRecord',
    entityId: month,
    // ผลจริง ไม่ใช่เจตนา (บทเรียน v1.186)
    changes: { month, candidates: candidates.length, created, synced, failed },
  })

  return NextResponse.json({
    month, dryRun: false,
    bookingsInMonth: bookings.length,
    alreadyHaveRows: hasRows.size,
    lockedNonDraft: locked.size,
    candidates: candidates.length,
    created, synced, failed,
  })
}
