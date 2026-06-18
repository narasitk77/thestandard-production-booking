import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { buildCSVHeader, rowToCSV, csvFilename } from '@/lib/csv'
import { bkkAt, durationHours } from '@/lib/planning'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/workspace/export-planning — v1.62.0 transition export.
 *
 * Reproduces the columns of the old manual planning sheet
 * (START / END / DESCRIPTION / DURATION / NOTES / LOCATION / CAMERA / เช่า)
 * straight from booking data, so the admin can keep the legacy CSV during the
 * switch-over and then stop maintaining the sheet by hand.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional; filter on shootDate).
 */
function dateOnly(v: Date | null | undefined): string {
  if (!v) return ''
  return new Date(v).toISOString().slice(0, 10)
}

export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const shootDate: Record<string, Date> = {}
  if (from) shootDate.gte = new Date(`${from}T00:00:00Z`)
  if (to) shootDate.lte = new Date(`${to}T00:00:00Z`)

  const rows = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { not: 'CANCELLED' },
      ...(from || to ? { shootDate } : {}),
    },
    include: { outlet: true, program: true, episodes: { orderBy: { sequence: 'asc' } } },
    orderBy: { shootDate: 'asc' },
  })

  const headers = ['START', 'END', 'DESCRIPTION', 'DURATION', 'NOTES', 'LOCATION', 'CAMERA', 'เช่า']
  let csv = buildCSVHeader(headers)

  for (const b of rows) {
    const start = bkkAt(b.shootDate, b.callTime)
    const end = bkkAt(b.shootEndDate || b.shootDate, b.estimatedWrap || b.callTime)
    const durationHrs = durationHours(start, end)
    const desc = `[${b.status}] ${b.projectName || b.program?.name || ''} (${b.outlet?.code || ''})`
    const episodeTitles = b.episodes.map((e) => e.title).filter(Boolean).join(', ')
    const notes = [
      `วันที่จอง: ${b.createdAt ? new Date(b.createdAt).toISOString() : '-'}`,
      `โปรเจกต์: ${b.projectName || b.program?.name || '-'}`,
      `ชื่อตอน: ${episodeTitles || '-'}`,
      `Quotation No. / Product Code: ${b.agencyRef || '-'}`,
      `กล้อง: ${b.cameraCount ?? '-'}`,
      `ไมค์: ${b.micCount ?? '-'}`,
      `สถานที่: ${b.locationName || '-'}`,
      `เวลาเซ็ทอัพ: ${b.callTime || '-'}`,
      `รายละเอียด (งานวิดีโอ): ${b.notes || '-'}`,
    ].join(' ')

    csv +=
      rowToCSV([
        start ? start.toISOString() : dateOnly(b.shootDate),
        end ? end.toISOString() : '',
        desc,
        durationHrs,
        notes,
        b.itinerary || '',
        b.equipmentNote || '',
        b.rentalGearNote || '',
      ]) + '\n'
  }

  const today = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('planning', from || today, to || today)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
