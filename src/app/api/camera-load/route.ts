import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { computeSlotLoad, CAMERA_LIMIT } from '@/lib/booking-overlap'
import { loadShortageLinesTh } from '@/lib/resource-load'

// v1.61.0 — POST { shootDate, callTime, estimatedWrap?, shootEndDate?,
// cameraCount?, excludeBookingId? } → the camera load for a candidate's slot.
//
// v1.177 — also reports the crew load (ช่างวิดีโอ / สวิตเชอร์) and returns the
// ready-made Thai advisory lines, so the wizard and the admin page cannot drift
// into wording the other doesn't have. Still advisory: it never rejects a booking.
// The v1.61 response fields are kept as-is for older clients.
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const {
      shootDate, shootEndDate, callTime, estimatedWrap, shootType,
      cameraCount, videographerCount, switcherCount, excludeBookingId,
    } = body || {}
    if (!shootDate || !callTime) {
      return NextResponse.json({ error: 'shootDate and callTime required' }, { status: 400 })
    }

    const { summary, warnings, pools } = await computeSlotLoad({
      shootDate, shootEndDate, callTime, estimatedWrap, shootType,
      cameraCount, videographerCount, switcherCount, excludeBookingId,
    })
    const cameras = summary.lines.find(l => l.key === 'cameras')!

    return NextResponse.json({
      // ── v1.61 shape (kept) ─────────────────────────────────────────────
      otherCameras: cameras.others,
      totalCameras: cameras.total,
      limit: CAMERA_LIMIT,
      exceedsLimit: cameras.over,
      // ── v1.177 ─────────────────────────────────────────────────────────
      // `warnings` = producer block (shortages + "admin จะจัดหาให้").
      // `shortages` = the same lines without the note, for the admin views.
      warnings,
      shortages: loadShortageLinesTh(summary),
      lines: summary.lines,
      competing: summary.competing,
      travelTight: summary.travelTight,
      pools,
    })
  } catch (error) {
    console.error('POST /api/camera-load error:', error)
    return NextResponse.json({ error: 'Failed to compute camera load' }, { status: 500 })
  }
}
