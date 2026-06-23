import { NextRequest, NextResponse } from 'next/server'
import { getSession, canUploadToBooking } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { buildFootageReport } from '@/lib/footage-report'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/report?bookingId=...
 *
 * v1.89 — per-camera file report (name, size, duration, resolution) read from
 * the Drive folders. Shown on the upload page and used by the delivery email.
 * Same access gate as /api/upload/list.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const bookingId = new URL(request.url).searchParams.get('bookingId')?.trim()
    if (!bookingId) return NextResponse.json({ error: 'bookingId is required' }, { status: 400 })
    if (!hasConsoleAccess(session.role)) {
      const check = await canUploadToBooking(session.email, bookingId)
      if (!check.ok) return NextResponse.json({ error: 'Forbidden', code: check.reason }, { status: 403 })
    }
    const report = await buildFootageReport(bookingId)
    return NextResponse.json({ report })
  } catch (e: any) {
    console.error('GET /api/upload/report error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
