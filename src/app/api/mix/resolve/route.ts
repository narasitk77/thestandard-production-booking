/**
 * v1.244 — GET /api/mix/resolve?q=<EP ID หรือ Booking ID>
 *
 * ตรวจว่าของที่คนพิมพ์หมายถึงใบจอง/ตอนไหน **ก่อน** ส่งคำขอ ให้ฟอร์มโชว์ว่า "จับคู่ได้กับอะไร"
 * ให้คนยืนยันด้วยตา — กฎการจับคู่อยู่ที่ resolveMixTarget (mix-jobs.ts) ที่นี่แค่ดึงแถว
 *
 * ทุกคนที่ล็อกอินเรียกได้: ตารางถ่ายโปร่งใส ใครก็เปิดใบจองได้อยู่แล้ว (booking-access.ts v1.152)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { resolveMixTarget } from '@/lib/mix-jobs'
import {
  loadCandidatesForQuery, toMixTargetView, toResolverInput, suggestMixTitle, openMixJobsFor,
} from '@/lib/mix-targets'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const q = (new URL(request.url).searchParams.get('q') || '').slice(0, 120)
    const rows = await loadCandidatesForQuery(q)
    const resolution = resolveMixTarget(q, rows.map(toResolverInput), session.email)

    const ids = resolution.kind === 'match' ? [resolution.pick.bookingId]
      : resolution.kind === 'ambiguous' ? Array.from(new Set(resolution.options.map(o => o.bookingId)))
        : []
    const views = rows.filter(r => ids.includes(r.id)).map(toMixTargetView)
    const byId = Object.fromEntries(views.map(v => [v.id, v]))
    const openJobs = await openMixJobsFor(ids)

    return NextResponse.json({
      resolution,
      bookings: byId,
      openJobs,
      suggestedTitle: resolution.kind === 'match' && byId[resolution.pick.bookingId]
        ? suggestMixTitle(byId[resolution.pick.bookingId], resolution.pick.episodeRowId)
        : null,
    })
  } catch (e) {
    console.error('GET /api/mix/resolve error:', e)
    // ล้มจริง = บอกว่าตรวจไม่ได้ ไม่ใช่ "ไม่พบ" — สองอย่างนี้ทำให้คนตัดสินใจต่างกัน
    return NextResponse.json({ error: 'ตรวจรหัสไม่สำเร็จ ลองใหม่อีกครั้ง' }, { status: 500 })
  }
}
