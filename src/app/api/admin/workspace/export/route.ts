import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { buildCSVHeader, rowToCSV, csvFilename } from '@/lib/csv'
import { WORKSPACE_COLUMN_MAP, type WorkspaceBooking } from '@/lib/workspace-columns'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/workspace/export — v1.55.0. Console only.
 *
 * Body: { ids: string[], columns: string[] }
 *   ids     — booking ids selected in the Workspace table
 *   columns — ordered column keys to include (see workspace-columns.ts)
 *
 * Returns a UTF-8 (BOM) CSV of exactly those rows + columns, built through the
 * shared `escapeCSVCell` so formula-injection neutralization is applied. The
 * client already filtered/selected; the server just fetches fresh by id so the
 * export reflects live data (and can't be tampered with field-by-field).
 */
export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  let body: { ids?: unknown; columns?: unknown; sortKey?: unknown; sortDir?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string').slice(0, 5000) : []
  const colKeys = Array.isArray(body.columns) ? body.columns.filter(x => typeof x === 'string') : []
  if (ids.length === 0) {
    return NextResponse.json({ error: 'No rows selected' }, { status: 400 })
  }

  const columns = colKeys.map(k => WORKSPACE_COLUMN_MAP[k]).filter(Boolean)
  if (columns.length === 0) {
    return NextResponse.json({ error: 'No valid columns selected' }, { status: 400 })
  }

  const rows = await prisma.booking.findMany({
    where: { id: { in: ids as string[] }, deletedAt: null },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
    },
  })

  // v1.55 — match the on-screen order: the client sends the active sort, and
  // the same column registry drives both, so the CSV row order == the table.
  const sortCol = typeof body.sortKey === 'string' ? WORKSPACE_COLUMN_MAP[body.sortKey] : undefined
  const dir = body.sortDir === 'asc' ? 1 : -1
  const ordered = [...rows] as unknown as WorkspaceBooking[]
  if (sortCol) {
    ordered.sort((a, b) =>
      sortCol.num
        ? (sortCol.num(a) - sortCol.num(b)) * dir
        : sortCol.value(a).localeCompare(sortCol.value(b), 'th') * dir,
    )
  } else {
    ordered.sort((a, b) => String(b.shootDate || '').localeCompare(String(a.shootDate || '')))
  }

  let csv = buildCSVHeader(columns.map(c => c.label))
  for (const r of ordered) {
    csv += rowToCSV(columns.map(c => c.value(r))) + '\n'
  }

  const today = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('workspace', today, today)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
