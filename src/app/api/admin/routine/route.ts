import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole, requireAdmin } from '@/lib/session'
import { createBookingFromPayload } from '@/lib/create-booking'
import { generateRoutineDates, ROUTINE_MAX_DAYS } from '@/lib/routine'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { clearBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * Routine planner — v1.56.0. Console only.
 *
 * GET  /api/admin/routine            → list routine groups (counts + range)
 * POST /api/admin/routine            → { action:'create' } bulk-generate, or
 *                                       { action:'cancel', routineGroupId }   bulk soft-delete a group
 *
 * "create" generates one normal REQUESTED Booking per matching weekday in the
 * range (skipping weekends / Thai holidays / custom dates), all tagged with a
 * shared routineGroupId + isRoutine. Each goes through createBookingFromPayload
 * so episode-ID minting, audit, and validation match a hand-made booking.
 */

export async function GET() {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  const rows = await prisma.booking.findMany({
    where: { routineGroupId: { not: null }, deletedAt: null },
    select: {
      routineGroupId: true, shootDate: true, status: true,
      outlet: { select: { code: true } }, program: { select: { name: true } },
    },
    orderBy: { shootDate: 'asc' },
  })

  const map = new Map<string, {
    routineGroupId: string; outlet: string; program: string
    count: number; from: string; to: string
    statuses: Record<string, number>
  }>()
  for (const r of rows) {
    const id = r.routineGroupId as string
    const day = r.shootDate.toISOString().slice(0, 10)
    const g = map.get(id)
    if (!g) {
      map.set(id, {
        routineGroupId: id, outlet: r.outlet?.code || '', program: r.program?.name || '',
        count: 1, from: day, to: day, statuses: { [r.status]: 1 },
      })
    } else {
      g.count++
      if (day < g.from) g.from = day
      if (day > g.to) g.to = day
      g.statuses[r.status] = (g.statuses[r.status] || 0) + 1
    }
  }
  return NextResponse.json({ groups: Array.from(map.values()).sort((a, b) => b.to.localeCompare(a.to)) })
}

export async function POST(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // ── cancel a whole group (bulk soft-delete) ─────────────────────────
  if (body?.action === 'cancel') {
    // v1.56.1 — bulk-cancel is more destructive than a single soft-delete,
    // so it matches that route's ADMIN-only gate (single delete = requireAdmin).
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const groupId = String(body.routineGroupId || '').trim()
    if (!groupId) return NextResponse.json({ error: 'routineGroupId required' }, { status: 400 })
    const rows = await prisma.booking.findMany({
      where: { routineGroupId: groupId, deletedAt: null },
      select: { id: true, calendarEventId: true },
    })
    if (rows.length === 0) return NextResponse.json({ error: 'ไม่พบงานในชุดนี้' }, { status: 404 })
    for (const r of rows) {
      if (r.calendarEventId) deleteCalendarEvent(r.calendarEventId).catch(() => {})
      clearBookingOT(r.id).catch(() => {})
    }
    await prisma.booking.updateMany({
      where: { routineGroupId: groupId, deletedAt: null },
      data: { deletedAt: new Date(), calendarEventId: null, calendarSyncStatus: null, calendarSyncError: null },
    })
    logAudit({
      actorEmail: session.email,
      action: 'routine.cancel',
      entityType: 'Booking',
      entityId: groupId,
      changes: { routineGroupId: groupId, count: rows.length },
    })
    return NextResponse.json({ ok: true, cancelled: rows.length })
  }

  // ── create ──────────────────────────────────────────────────────────
  const {
    outletCode, programCode, episodeTitle, category, videoType, shootType,
    callTime, estimatedWrap, locationName, producer, producerEmail,
    crewRequired, cameraCount, micCount, vanCount, videographerCount, switcherCount, notes,
    plan,
  } = body || {}

  if (!plan || typeof plan !== 'object') return NextResponse.json({ error: 'plan required' }, { status: 400 })
  const gen = generateRoutineDates({
    startDate: String(plan.startDate || ''),
    endDate: String(plan.endDate || ''),
    weekdays: Array.isArray(plan.weekdays) ? plan.weekdays.map(Number) : [],
    skipHolidays: plan.skipHolidays !== false,
    customSkip: Array.isArray(plan.customSkip) ? plan.customSkip.map(String) : [],
  })
  if (gen.error) return NextResponse.json({ error: gen.error }, { status: 400 })
  if (gen.dates.length === 0) return NextResponse.json({ error: 'ไม่มีวันที่จะสร้างเลย (ทุกวันถูกข้าม)' }, { status: 400 })
  if (gen.dates.length > ROUTINE_MAX_DAYS) return NextResponse.json({ error: `เกิน ${ROUTINE_MAX_DAYS} วัน` }, { status: 400 })

  // v1.56.1 — skip dates that already have a live booking for the same
  // outlet+program, so re-running an overlapping range can't silently
  // double-book a daily show. Reported back as duplicatesSkipped.
  const existing = await prisma.booking.findMany({
    where: {
      outlet: { code: String(outletCode) },
      program: { code: String(programCode) },
      deletedAt: null,
      shootDate: { in: gen.dates.map(d => new Date(d)) },
    },
    select: { shootDate: true },
  })
  const dupSet = new Set(existing.map(e => e.shootDate.toISOString().slice(0, 10)))
  const targetDates = gen.dates.filter(d => !dupSet.has(d))
  if (targetDates.length === 0) {
    return NextResponse.json({ error: 'ทุกวันมี booking อยู่แล้ว (จองซ้ำ) — ไม่มีอะไรให้สร้าง', duplicatesSkipped: dupSet.size }, { status: 400 })
  }

  const title = String(episodeTitle || '').trim() || 'Routine'
  const routineGroupId = crypto.randomUUID()
  const base = {
    outletCode, programCode, category, videoType, shootType,
    callTime, estimatedWrap, locationName, producer, producerEmail,
    crewRequired, cameraCount, micCount, vanCount, videographerCount, switcherCount, notes,
    isRoutine: true,
    routineGroupId,
    episodes: [{ programCode, title, contentType: category === 'ADVERTORIAL' ? 'ADVERTORIAL' : 'ORIGINAL_CONTENT' }],
  }

  const created: string[] = []
  const failed: { date: string; error: string }[] = []
  // Sequential: keeps episode-ID sequence minting collision-free and load light.
  for (const date of targetDates) {
    const res = await createBookingFromPayload({ ...base, shootDate: date }, session.email)
    if (res.ok) created.push(res.booking.bookingCode || res.booking.id)
    else failed.push({ date, error: res.error })
  }

  logAudit({
    actorEmail: session.email,
    action: 'routine.create',
    entityType: 'Booking',
    entityId: routineGroupId,
    changes: { routineGroupId, outletCode, programCode, created: created.length, failed: failed.length },
  })

  return NextResponse.json({
    ok: true,
    routineGroupId,
    requested: gen.dates.length,
    created: created.length,
    duplicatesSkipped: dupSet.size,
    failed,
    skipped: gen.skipped,
  })
}
