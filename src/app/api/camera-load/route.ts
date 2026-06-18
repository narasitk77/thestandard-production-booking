import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { computeOverlapCameraCount, CAMERA_LIMIT } from '@/lib/booking-overlap'

// v1.61.0 — POST { shootDate, callTime, estimatedWrap?, shootEndDate?,
// cameraCount?, excludeBookingId? } → { otherCameras, totalCameras, limit,
// exceedsLimit }. Advisory: reports the camera load for a candidate's
// time-overlapping slot; never rejects a booking.
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const { shootDate, shootEndDate, callTime, estimatedWrap, cameraCount, excludeBookingId } = body || {}
    if (!shootDate || !callTime) {
      return NextResponse.json({ error: 'shootDate and callTime required' }, { status: 400 })
    }

    const own = Math.max(0, parseInt(String(cameraCount), 10) || 0)
    const otherCameras = await computeOverlapCameraCount({ shootDate, shootEndDate, callTime, estimatedWrap, excludeBookingId })
    const totalCameras = otherCameras + own

    return NextResponse.json({
      otherCameras,
      totalCameras,
      limit: CAMERA_LIMIT,
      exceedsLimit: totalCameras > CAMERA_LIMIT,
    })
  } catch (error) {
    console.error('POST /api/camera-load error:', error)
    return NextResponse.json({ error: 'Failed to compute camera load' }, { status: 500 })
  }
}
