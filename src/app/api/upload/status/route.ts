import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/status?bookingIds=a,b,c
 *
 * v1.85 — per-booking upload summary for the videographer's job list: how many
 * distinct cameras have COMPLETE uploads + total completed files. Drives the
 * "ยังไม่อัป / อัปบางกล้อง / อัปครบ" badge so crew can see at a glance which of
 * their shoots still need footage. Counts only (no file details) — kept cheap
 * with a single groupBy, gated on an authenticated session.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const raw = new URL(request.url).searchParams.get('bookingIds')?.trim()
    const ids = (raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 300)
    if (ids.length === 0) return NextResponse.json({ status: {} })

    const rows = await prisma.upload.groupBy({
      // v1.93 — group by episodeId too so `epSlots` can count distinct
      // (episode × camera) slots: a 2-EP / 2-cam shoot needs 4 filled to be
      // "ครบ", not 2. Keeps the badge honest once footage is split per EP.
      by: ['bookingId', 'camera', 'episodeId'],
      where: { bookingId: { in: ids }, status: 'COMPLETE' },
      _count: { _all: true },
    })

    // v1.92.1 — count only CAM-* sources (a physical camera), so "อัปครบ" isn't
    // falsely satisfied by AUDIO / DRONE / SWITCHER / PHOTO / SCREEN.
    // v1.93 — two SEPARATE buckets so legacy (episodeId=null) and EP-tagged
    // uploads never collide in the count:
    //   epSlots  = distinct (EP × CAM-*) pairs that are EP-tagged → used for
    //              bookings that have episodes (expected = cameraCount × #EP)
    //   flatCams = distinct CAM-* with no episode → used for no-episode bookings
    //              (and legacy flat footage, which the UI ignores once a booking
    //              has episodes). `files` = total across all sources.
    const status: Record<string, { epSlots: number; flatCams: number; files: number }> = {}
    for (const id of ids) status[id] = { epSlots: 0, flatCams: 0, files: 0 }
    for (const r of rows) {
      const s = status[r.bookingId]
      if (!s) continue
      if (/^CAM-/i.test(r.camera)) {
        if (r.episodeId) s.epSlots += 1
        else s.flatCams += 1
      }
      s.files += r._count._all
    }

    return NextResponse.json({ status })
  } catch (e: any) {
    console.error('GET /api/upload/status error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
