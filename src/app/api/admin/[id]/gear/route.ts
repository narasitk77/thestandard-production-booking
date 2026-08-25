import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { summarizeGearNotes } from '@/lib/gear-notes'
import { updateCalendarEventDetails } from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/:bookingId/gear
 * body: { episodeId: <Episode.id>, equipmentNote?: string, rentalGearNote?: string }
 *
 * v1.197 — บันทึกอุปกรณ์/ของเช่า **ราย Production ID** จากหน้า Week Plan
 *
 * เขียนสองอย่างในทรานแซกชันเดียว: โน้ตของ episode (ตัวจริง) และสรุประดับใบจอง
 * (ค่าที่คำนวณมา) — สรุปต้องไม่มีทางหลุดจากตัวจริง เพราะ 7 จุดที่อ่านของเดิม
 * (ปฏิทิน, reconcile, export, หน้าเช่า) ยังอ่านช่องระดับใบจองอยู่
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await request.json().catch(() => null)
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId : ''
  if (!episodeId) return NextResponse.json({ error: 'episodeId required' }, { status: 400 })

  const { equipmentNote, rentalGearNote } = body || {}
  if (equipmentNote === undefined && rentalGearNote === undefined) {
    return NextResponse.json({ error: 'ไม่มีอะไรให้บันทึก' }, { status: 400 })
  }

  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, bookingId: true, episodeId: true },
  })
  // ผูก episode กับ booking ใน URL เสมอ — กัน id หลุดข้ามใบ
  if (!episode || episode.bookingId !== params.id) {
    return NextResponse.json({ error: 'ไม่พบ Production ID นี้ในงานนี้' }, { status: 404 })
  }

  const booking = await prisma.$transaction(async (tx) => {
    await tx.episode.update({
      where: { id: episodeId },
      data: {
        ...(equipmentNote !== undefined && { equipmentNote: equipmentNote || null }),
        ...(rentalGearNote !== undefined && { rentalGearNote: rentalGearNote || null }),
      },
    })
    const eps = await tx.episode.findMany({
      where: { bookingId: params.id },
      orderBy: { sequence: 'asc' },
      select: { episodeId: true, equipmentNote: true, rentalGearNote: true },
    })
    return tx.booking.update({
      where: { id: params.id },
      data: {
        equipmentNote: summarizeGearNotes(eps, 'equipmentNote'),
        rentalGearNote: summarizeGearNotes(eps, 'rentalGearNote'),
      },
      include: { episodes: { orderBy: { sequence: 'asc' } }, outlet: true, program: true },
    })
  })

  logAudit({
    actorEmail: session.email,
    action: 'booking.gear_note_edit',
    entityType: 'Booking',
    entityId: params.id,
    bookingCode: booking.bookingCode,
    changes: {
      productionId: episode.episodeId,
      ...(equipmentNote !== undefined && { equipmentNote: equipmentNote || null }),
      ...(rentalGearNote !== undefined && { rentalGearNote: rentalGearNote || null }),
    },
  })

  // เส้นเดียวกับ PATCH ของใบจอง: อุปกรณ์ขึ้นในคำอธิบายอีเวนต์ปฏิทิน
  // fire-and-forget — ปฏิทินสะดุดต้องไม่ทำให้การบันทึกล้ม (reconciler เป็นตาข่าย)
  if (booking.calendarEventId) {
    updateCalendarEventDetails(booking.calendarEventId, booking).catch(e =>
      console.error('[gear] updateCalendarEventDetails failed (non-fatal):', e?.message || e))
  }

  return NextResponse.json({
    ok: true,
    episodes: booking.episodes.map(e => ({
      id: e.id, episodeId: e.episodeId,
      equipmentNote: e.equipmentNote, rentalGearNote: e.rentalGearNote,
    })),
    bookingSummary: { equipmentNote: booking.equipmentNote, rentalGearNote: booking.rentalGearNote },
  })
}
