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
      by: ['bookingId', 'camera'],
      where: { bookingId: { in: ids }, status: 'COMPLETE' },
      _count: { _all: true },
    })

    const status: Record<string, { cameras: number; files: number }> = {}
    for (const id of ids) status[id] = { cameras: 0, files: 0 }
    for (const r of rows) {
      const s = status[r.bookingId]
      if (!s) continue
      s.cameras += 1
      s.files += r._count._all
    }

    return NextResponse.json({ status })
  } catch (e: any) {
    console.error('GET /api/upload/status error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
