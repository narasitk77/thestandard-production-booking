/**
 * GET /api/audit/export?from=YYYY-MM-DD&to=YYYY-MM-DD&action=&entityId=
 *
 * Admin-only. Streams audit_logs rows in the requested range as a UTF-8 CSV.
 * The response is streamed page-by-page (500 rows at a time) so memory stays
 * flat even when exporting 90 days of activity at once.
 *
 * Defaults: from = 90 days ago, to = now.
 */
import { NextRequest } from 'next/server'
import { requireConsole } from '@/lib/session'
import { iterateAuditLogs, RETENTION_DAYS } from '@/lib/audit-retention'
import { streamCSV, csvFilename } from '@/lib/csv'

const COLUMNS = [
  'at',
  'actor_email',
  'action',
  'entity_type',
  'entity_id',
  'booking_code',
  'from_status',
  'to_status',
  'changes_json',
]

export async function GET(request: NextRequest) {
  if (!(await requireConsole())) {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { searchParams } = new URL(request.url)
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const fromStr = searchParams.get('from')
  const toStr = searchParams.get('to')
  const from = fromStr ? new Date(fromStr) : defaultFrom
  const to = toStr ? new Date(toStr) : now
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return new Response(JSON.stringify({ error: 'Invalid from/to' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const action = searchParams.get('action') ?? undefined
  const entityId = searchParams.get('entityId') ?? undefined

  const rows = iterateAuditLogs({ from, to, action, entityId })
  const stream = streamCSV(COLUMNS, rows, (r) => [
    r.at,
    r.actorEmail,
    r.action,
    r.entityType,
    r.entityId,
    r.bookingCode,
    r.fromStatus,
    r.toStatus,
    r.changes,
  ])

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(
        'audit',
        from.toISOString(),
        to.toISOString(),
      )}"`,
      'Cache-Control': 'no-store',
    },
  })
}
