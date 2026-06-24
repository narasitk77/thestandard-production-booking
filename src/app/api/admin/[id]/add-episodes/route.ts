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

    await prisma.$transaction(
      toAdd.map(ep => prisma.episode.create({
        data: {
          bookingId: booking.id,
          episodeId: ep.episodeId,
          sequence: ep.sequence,
          title: ep.title,
          programId: booking.programId!,
        },
      }))
    )

    const updated = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
      },
    })

    return NextResponse.json({ ok: true, added: toAdd.length, skipped, booking: updated })
  } catch (e) {
    console.error('POST /api/admin/[id]/add-episodes error:', e)
    return NextResponse.json({ error: 'เพิ่ม episode ไม่สำเร็จ' }, { status: 500 })
  }
}
