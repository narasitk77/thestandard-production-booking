import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { prisma } from '@/lib/db'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/gear-backfill[?dryRun=1]
 *
 * v1.197 — ย้ายโน้ตอุปกรณ์/เช่าที่เคยเก็บระดับใบจอง ลงไปที่ Production ID
 * ของใบนั้น เพื่อให้หน้า Week Plan แบบใหม่เห็นของเดิมที่กรอกไว้แล้ว
 *
 * ของจริงบนพรอด 2026-08-25: 42 ใบที่มี ID เดียว + 6 ใบที่มีหลาย ID มีโน้ตอยู่
 * ใบที่มีหลาย ID: โน้ตเดิมเขียนไว้สำหรับทั้งกอง จึงคัดลงทุก ID (summarizeGearNotes
 * ยุบข้อความที่เหมือนกันให้เหลือชุดเดียว สรุประดับใบจองจึงไม่เปลี่ยนหน้าตา)
 *
 * รันซ้ำได้: แตะเฉพาะ episode ที่ยังไม่มีโน้ตของตัวเอง — ของที่กรอกราย ID ไปแล้ว
 * จะไม่ถูกทับ
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-gear-backfill-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = new URL(request.url).searchParams.get('dryRun') !== '0'

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      OR: [
        { equipmentNote: { not: null } },
        { rentalGearNote: { not: null } },
      ],
    },
    select: {
      id: true, bookingCode: true, equipmentNote: true, rentalGearNote: true,
      episodes: { select: { id: true, episodeId: true, equipmentNote: true, rentalGearNote: true } },
    },
  })

  const plan: { code: string | null; episodes: number; equip: boolean; rental: boolean }[] = []
  const noEpisodes: string[] = []
  let episodesTouched = 0

  for (const b of bookings) {
    const equip = (b.equipmentNote || '').trim()
    const rental = (b.rentalGearNote || '').trim()
    if (!equip && !rental) continue
    if (b.episodes.length === 0) { noEpisodes.push(b.bookingCode || b.id); continue }
    const targets = b.episodes.filter(e =>
      (equip && !(e.equipmentNote || '').trim()) || (rental && !(e.rentalGearNote || '').trim()))
    if (targets.length === 0) continue
    plan.push({ code: b.bookingCode, episodes: targets.length, equip: !!equip, rental: !!rental })
    episodesTouched += targets.length

    if (!dryRun) {
      for (const e of targets) {
        await prisma.episode.update({
          where: { id: e.id },
          data: {
            ...(equip && !(e.equipmentNote || '').trim() ? { equipmentNote: equip } : {}),
            ...(rental && !(e.rentalGearNote || '').trim() ? { rentalGearNote: rental } : {}),
          },
        })
      }
    }
  }

  const summary = {
    bookingsWithNotes: bookings.length,
    bookingsToBackfill: plan.length,
    episodesTouched,
    // ใบที่ไม่มี Production ID เลย — โน้ตค้างอยู่ระดับใบจอง แก้ผ่าน Week Plan ไม่ได้
    bookingsWithNoEpisodes: noEpisodes,
    sample: plan.slice(0, 20),
  }

  if (!dryRun) {
    logAudit({
      actorEmail: 'gear-backfill', action: 'booking.gear_backfill',
      entityType: 'Episode', entityId: 'bulk', changes: summary,
    })
  }
  return NextResponse.json({ dryRun, ...summary })
}
