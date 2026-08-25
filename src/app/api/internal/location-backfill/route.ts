import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { prisma } from '@/lib/db'
import { resolveLocationId, isPlaceholderLocation } from '@/lib/location-resolve'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/location-backfill[?dryRun=1][&limit=]
 *
 * v1.195 — เติม `Booking.locationId` ให้แถวเก่าจาก `locationName`
 * ของใหม่ได้ id ตั้งแต่ตอนสร้างแล้ว (create-booking) ตัวนี้ไว้ล้างของเก่าครั้งเดียว
 * รันซ้ำได้ (แตะเฉพาะแถวที่ยังไม่มี id) และไม่แก้ `locationName` เลย
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-location-backfill-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1' || searchParams.get('dryRun') === 'true'
  const limit = Math.min(2000, Math.max(1, parseInt(searchParams.get('limit') || '2000', 10) || 2000))

  const rows = await prisma.booking.findMany({
    where: { deletedAt: null, locationId: null },
    select: { id: true, bookingCode: true, locationName: true },
    take: limit,
  })

  const plan: { id: string; code: string | null; from: string; to: string }[] = []
  const unresolved = new Map<string, number>()
  let placeholder = 0
  for (const r of rows) {
    const id = resolveLocationId(r.locationName)
    if (id) {
      plan.push({ id: r.id, code: r.bookingCode, from: r.locationName || '', to: id })
    } else if (isPlaceholderLocation(r.locationName)) {
      placeholder++
    } else {
      const k = (r.locationName || '(ว่าง)').slice(0, 70)
      unresolved.set(k, (unresolved.get(k) || 0) + 1)
    }
  }

  // สรุปว่าแต่ละห้องจะได้กี่ใบ — ตัวเลขนี้คือสิ่งที่ต้องเอาไปเทียบก่อน/หลัง
  const byRoom: Record<string, number> = {}
  for (const p of plan) byRoom[p.to] = (byRoom[p.to] || 0) + 1

  const summary = {
    scanned: rows.length,
    willSet: plan.length,
    placeholder,
    unresolvedRows: Array.from(unresolved.values()).reduce((a, b) => a + b, 0),
    byRoom,
    // ข้อความที่แมปไม่ได้ + จำนวน — ต้องอ่านก่อนกด apply ว่ามีห้องในตึกหลุดมาไหม
    unresolvedSamples: Array.from(unresolved.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 40)
      .map(([value, n]) => ({ n, value })),
  }

  if (dryRun) return NextResponse.json({ dryRun: true, ...summary })

  let updated = 0
  // จัดกลุ่มตาม id ปลายทาง → updateMany ทีละกลุ่ม (แทน 300+ query)
  const groups = new Map<string, string[]>()
  for (const p of plan) {
    if (!groups.has(p.to)) groups.set(p.to, [])
    groups.get(p.to)!.push(p.id)
  }
  for (const [locId, ids] of Array.from(groups.entries())) {
    const res = await prisma.booking.updateMany({
      where: { id: { in: ids }, locationId: null },
      data: { locationId: locId },
    })
    updated += res.count
  }

  logAudit({
    actorEmail: 'location-backfill',
    action: 'booking.location_backfill',
    entityType: 'Booking',
    entityId: 'bulk',
    changes: { ...summary, updated },
  })

  return NextResponse.json({ dryRun: false, ...summary, updated })
}
