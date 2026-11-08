/**
 * POST /api/admin/:id/add-episodes  (v1.95.0)
 *
 * Link EXISTING project episodes (source of truth = Producer Dashboard Sheet)
 * onto an already-created Content Agency booking — including CONFIRMED ones, so
 * a director's extra shoots can be attached after approval. Mirrors
 * create-booking's AGN episode-row construction.
 *
 * Safety:
 *  - Admin only (requireConsole).
 *  - Add-only: never edits or removes existing episodes.
 *  - NEVER mints episode IDs — only links episodes that already exist in the
 *    project Sheet (minting was deliberately removed; see dashboard-episodes.ts).
 *  - Content Agency only (other outlets mint IDs at booking-create time).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { planEpisodesToLink, type ProjectEp } from '@/lib/link-episodes'
import { logAudit } from '@/lib/audit'
import { pushCalendarDetails } from '@/lib/calendar-reconcile'
import { updateBookingRow, joinEpisodeTitles } from '@/lib/google-sheets'
import { EPISODE_ORDER } from '@/lib/episode-order'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireConsole()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const episodeIds: string[] = Array.isArray(body.episodeIds) ? body.episodeIds : []
    if (episodeIds.length === 0) {
      return NextResponse.json({ error: 'เลือก episode อย่างน้อย 1 ตอน' }, { status: 400 })
    }
    if (episodeIds.length > 20) {
      return NextResponse.json({ error: 'เพิ่มได้สูงสุด 20 ตอนต่อครั้ง' }, { status: 400 })
    }

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { outlet: true, episodes: { select: { episodeId: true, sequence: true } } },
    })
    if (!booking) return NextResponse.json({ error: 'ไม่พบ booking' }, { status: 404 })
    // Prod behaviour: EPs can still be added to a CANCELLED or soft-deleted booking
    // (refusing it is pending Nat's decision) — but say so loudly, in the reply and
    // the audit row, because its calendar event / sheet row are gone or going.
    const deadWarning = booking.deletedAt
      ? 'ใบจองนี้ถูกลบแล้ว — เพิ่ม EP ในฐานข้อมูลแล้ว แต่ปฏิทิน/ชีทของใบนี้ไม่ได้ถูกอัปเดต'
      : booking.status === 'CANCELLED'
        ? 'ใบจองนี้ถูกยกเลิกแล้ว — เพิ่ม EP ในฐานข้อมูลแล้ว แต่ปฏิทิน/ชีทของใบนี้ไม่ได้ถูกอัปเดต'
        : null

    // Safe path only: Content Agency, where episodes come from the project Sheet.
    if (booking.outlet?.code !== 'AGN' || !booking.projectId) {
      return NextResponse.json(
        { error: 'รองรับเฉพาะ Content Agency (เลือก episode จาก project)' },
        { status: 400 }
      )
    }
    if (!booking.programId) {
      return NextResponse.json({ error: 'booking ไม่มี program — ข้อมูลไม่ครบ' }, { status: 400 })
    }

    // Re-fetch project episodes from the Sheet (source of truth) and validate.
    const epList = await listProjectEpisodes(booking.projectId)
    if (!epList.ok) {
      return NextResponse.json({ error: `โหลด episode ของ project ไม่ได้ (${epList.error})` }, { status: 503 })
    }
    const byId = new Map<string, ProjectEp>(
      epList.episodes.map(e => [e.episodeId, { episodeId: e.episodeId, ep: e.ep, projectName: e.projectName }])
    )
    const existing = new Set(booking.episodes.map(e => e.episodeId))
    const maxSeq = booking.episodes.reduce((m, e) => Math.max(m, e.sequence), 0)

    const { toAdd, skipped } = planEpisodesToLink(episodeIds, byId, existing, maxSeq)
    if (toAdd.length === 0) {
      return NextResponse.json(
        { error: 'ไม่มี episode ใหม่ให้เพิ่ม (มีอยู่แล้ว หรือไม่อยู่ใน project)', skipped },
        { status: 400 }
      )
    }

    // Insert inside an interactive transaction that RE-READS the booking's
    // episodes first — so a retried/duplicate request (or one fired before the
    // client refreshed) can't double-insert the same episodeId, and the
    // sequence always continues from the true current max. (The model has no
    // @@unique on (bookingId, episodeId) — adding one needs a monitored
    // db-push window since it builds an index; the re-read covers the realistic
    // retry case without that risk.)
    const created = await prisma.$transaction(async (tx) => {
      const fresh = await tx.episode.findMany({
        where: { bookingId: booking.id },
        select: { episodeId: true, sequence: true },
      })
      const have = new Set(fresh.map(e => e.episodeId))
      let seq = fresh.reduce((m, e) => Math.max(m, e.sequence), 0)
      const rows: { episodeId: string }[] = []
      for (const ep of toAdd) {
        if (have.has(ep.episodeId)) continue // already added (concurrent/retry) — skip
        seq += 1
        await tx.episode.create({
          data: {
            bookingId: booking.id,
            episodeId: ep.episodeId,
            sequence: seq,
            title: ep.title,
            programId: booking.programId!,
          },
        })
        have.add(ep.episodeId)
        rows.push({ episodeId: ep.episodeId })
      }
      return rows
    })

    const updated = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
      },
    })

    // Audit trail (fire-and-forget) — matches the convention of every other
    // admin booking mutation (PATCH, approve, etc.).
    logAudit({
      actorEmail: session.email,
      action: 'booking.episodes_added',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: { episodeIds: created.map(e => e.episodeId), count: created.length, ...(deadWarning ? { bookingStatus: booking.status, deleted: !!booking.deletedAt } : {}) },
    })

    // Sheet: Episode IDs (col Q) + Episode Titles (col AH) must list the EPs the
    // booking now has — the twin remove-episodes writes them ("otherwise PMDC still
    // sees IDs that no longer exist"); this add path never did, so PMDC's Airtable
    // sync never mapped the added EPs to this Production ID. updateBookingRow never
    // throws — check its result.
    if (updated && created.length > 0) {
      updateBookingRow(updated.bookingCode || updated.id, {
        episodeIds: updated.episodes.map(e => e.episodeId).join(', '),
        episodeTitles: joinEpisodeTitles(updated.episodes),
      }).then(r => {
        if (r === 'error' || r === 'not-found') console.error(`[add-episodes] sheet Episode IDs/Titles ${r} for ${updated.bookingCode}`)
      })
    }

    // Re-sync the live Google Calendar event so its title + episode list reflect
    // the added EPs. A failed patch marks the booking FAILED (reconciler retries).
    if (updated?.calendarEventId) {
      void pushCalendarDetails(updated.calendarEventId, updated as Parameters<typeof pushCalendarDetails>[1])
    }

    return NextResponse.json({ ok: true, added: created.length, skipped, booking: updated, ...(deadWarning ? { warning: deadWarning } : {}) })
  } catch (e) {
    console.error('POST /api/admin/[id]/add-episodes error:', e)
    return NextResponse.json({ error: 'เพิ่ม episode ไม่สำเร็จ' }, { status: 500 })
  }
}
