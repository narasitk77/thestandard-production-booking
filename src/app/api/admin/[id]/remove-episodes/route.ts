/**
 * POST /api/admin/:id/remove-episodes   (v1.236)
 *
 * ลดจำนวนตอนในใบจอง — คู่ตรงข้ามของ add-episodes แต่ **ระวังกว่ามาก** เพราะ
 * ลบแล้วไม่มีทางกู้ ID กลับ (ห้ามมินต์ซ้ำ ไม่งั้น Production ID จะชนของเก่า)
 *
 * ADMIN + รายคนใน EPISODE_REMOVER_EMAILS (v1.284 · ค่าเริ่มต้นตุ้ย) — ไม่ใช่ requireConsole
 * เหมือน add-episodes ตามคอนเวนชันของรีโปที่งานทำลายข้อมูลใช้ด่านที่แคบกว่า
 * (ดู bulk-cancel ใน admin/routine/route.ts) · ดู canRemoveEpisodes ใน session.ts
 *
 * กฎว่าลบอะไรได้บ้างอยู่ที่ `src/lib/episode-removal.ts` ที่เดียว (เทสได้ 9 เคส)
 * เส้นนี้รับผิดชอบแค่ "ลงมือตามแผน" และตามเก็บผลข้างเคียงให้ครบ:
 *   1. ลบแถว episode (uploads.episodeId เป็น SET NULL — ไฟล์ไม่หาย แต่แผนกัน
 *      ไม่ให้ลบตอนที่มีไฟล์อยู่แล้ว จึงไม่ควรมีไฟล์ไหนกำพร้าจากเส้นนี้)
 *   2. คำนวณสรุปอุปกรณ์บนใบจองใหม่จากตอนที่เหลือ — ช่องนั้นเป็นค่าที่คำนวณมา
 *      (gear-notes.ts) ถ้าไม่คำนวณใหม่จะค้างอุปกรณ์ของตอนที่ไม่มีแล้ว
 *   3. เขียน audit (เส้นนี้เป็นการลบ ต้องมีร่องรอยเสมอ)
 *   4. แก้คอลัมน์ Episode IDs / Episode Titles ในชีทให้ตรง
 *   5. patch คำอธิบาย event ปฏิทิน (ถ้ามี) — แบบเดียวกับ add-episodes
 *
 * **ไม่ลบโฟลเดอร์ Drive ของตอนนั้น** โดยตั้งใจ: folder-integrity สร้าง/เปลี่ยนชื่อ
 * อย่างเดียว ไม่เคยลบ และโฟลเดอร์ว่างที่ค้างไว้ราคาถูกกว่าการลบของที่อาจมีไฟล์
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canRemoveEpisodes } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { planEpisodeRemoval, type RemovableEpisode } from '@/lib/episode-removal'
import { summarizeGearNotes } from '@/lib/gear-notes'
import { pushCalendarDetails } from '@/lib/calendar-reconcile'
import { updateBookingRow, joinEpisodeTitles } from '@/lib/google-sheets'
import { EPISODE_ORDER } from '@/lib/episode-order'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session || !canRemoveEpisodes(session)) return NextResponse.json({ error: 'ไม่มีสิทธิ์ลดจำนวนตอน (เฉพาะ Admin และคนที่ได้รับสิทธิ์)' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const ids: string[] = Array.isArray(body.episodeRowIds) ? body.episodeRowIds.map(String) : []
    const dryRun = body.dryRun === true

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        program: true,
        episodes: {
          orderBy: EPISODE_ORDER,
          include: {
            program: { select: { name: true } },
            _count: { select: { uploads: true } },
          },
        },
      },
    })
    if (!booking) return NextResponse.json({ error: 'ไม่พบ booking' }, { status: 404 })
    if (booking.deletedAt) return NextResponse.json({ error: 'ใบจองถูกลบไปแล้ว' }, { status: 409 })

    const all: RemovableEpisode[] = booking.episodes.map(e => ({
      id: e.id,
      episodeId: e.episodeId,
      title: e.title,
      sequence: e.sequence,
      uploadCount: e._count.uploads,
      programName: e.program?.name ?? null,
    }))

    const plan = planEpisodeRemoval(all, ids, booking.program.name)

    // dry-run เดินเส้นเดียวกันทุกบรรทัดจนถึงตรงนี้ แล้วค่อยแยก — ไม่ใช่ทางลัด
    // ที่ประเมินจากข้อมูลคนละชุดกับของจริง (bug class 5 ของรีโปนี้)
    if (dryRun || plan.remove.length === 0) {
      return NextResponse.json({
        ok: plan.remove.length > 0,
        // ต้องบอกความจริงว่านี่เป็น dry-run หรือเป็นของจริงที่ไม่มีอะไรให้ทำ
        // สองอย่างนี้ต่างกัน และผู้เรียกที่เชื่อว่า "dryRun:true แปลว่ายังไม่ได้ทำ"
        // จะยิงซ้ำโดยคิดว่าปลอดภัย
        dryRun,
        nothingToDo: plan.remove.length === 0,
        willRemove: plan.remove.map(e => ({ episodeId: e.episodeId, title: e.title })),
        blocked: plan.blocked,
        remaining: plan.remaining.map(e => e.episodeId),
        folderNameWillChange: plan.folderNameWillChange,
      })
    }

    const removeRowIds = plan.remove.map(e => e.id)
    const remainingEps = booking.episodes.filter(e => !removeRowIds.includes(e.id))

    await prisma.$transaction(async tx => {
      // guard ซ้ำในทรานแซกชัน: ถ้ามีคนอัปโหลดไฟล์เข้าตอนนั้นระหว่างที่เรากำลังคิด
      // แผนจะเก่าไปแล้ว — deleteMany ที่มีเงื่อนไข uploads none กันไว้อีกชั้น
      const stillClean = await tx.episode.findMany({
        where: { id: { in: removeRowIds }, bookingId: booking.id, uploads: { none: {} } },
        select: { id: true },
      })
      if (stillClean.length !== removeRowIds.length) {
        throw new Error('EPISODE_CHANGED')
      }
      await tx.episode.deleteMany({ where: { id: { in: removeRowIds }, bookingId: booking.id } })

      // สรุปอุปกรณ์บนใบจองเป็นค่าที่คำนวณจากตอน — คำนวณใหม่ในทรานแซกชันเดียวกัน
      const gear = remainingEps.map(e => ({
        episodeId: e.episodeId,
        equipmentNote: e.equipmentNote,
        rentalGearNote: e.rentalGearNote,
      }))
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          equipmentNote: summarizeGearNotes(gear, 'equipmentNote'),
          rentalGearNote: summarizeGearNotes(gear, 'rentalGearNote'),
        },
      })
    })

    const updated = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
      },
    })

    await logAudit({
      actorEmail: session.email,
      action: 'booking.episodes_removed',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: {
        removed: plan.remove.map(e => e.episodeId),
        remaining: plan.remaining.map(e => e.episodeId),
        folderNameWillChange: plan.folderNameWillChange,
      },
    })

    // ชีท: คอลัมน์ Episode IDs (Q) + Episode Titles (AH) ต้องตรงกับที่เหลือจริง
    // ไม่งั้น PMDC อ่านจากชีทแล้วยังเห็น ID ที่ไม่มีอยู่แล้ว
    if (booking.bookingCode && updated) {
      // updateBookingRow never throws — a .catch never fired; read what it returns
      updateBookingRow(booking.bookingCode, {
        episodeIds: updated.episodes.map(e => e.episodeId).join(', '),
        episodeTitles: joinEpisodeTitles(updated.episodes),
      }).then(r => {
        if (r === 'error' || r === 'not-found') console.error(`[remove-episodes] sheet Episode IDs/Titles write ${r} for ${booking.bookingCode}`)
      })
    }

    if (updated?.calendarEventId) {
      // never throws; a failed patch marks the row FAILED and the reconciler retries it
      void pushCalendarDetails(updated.calendarEventId, updated as Parameters<typeof pushCalendarDetails>[1])
    }

    return NextResponse.json({
      ok: true,
      removed: plan.remove.map(e => e.episodeId),
      blocked: plan.blocked,
      remaining: updated?.episodes.map(e => e.episodeId) ?? [],
      folderNameWillChange: plan.folderNameWillChange,
      booking: updated,
    })
  } catch (e: any) {
    if (e?.message === 'EPISODE_CHANGED') {
      return NextResponse.json(
        { error: 'ตอนที่เลือกเปลี่ยนไประหว่างนี้ (อาจมีไฟล์เพิ่งอัปโหลดเข้ามา) — รีเฟรชแล้วลองใหม่' },
        { status: 409 },
      )
    }
    console.error('POST /api/admin/[id]/remove-episodes error:', e)
    return NextResponse.json({ error: 'ลบตอนไม่สำเร็จ' }, { status: 500 })
  }
}
