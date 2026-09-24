import { NextRequest, NextResponse } from 'next/server'
import type { BookingStatus } from '@prisma/client'
import { releaseRoomForBooking } from '@/lib/room-booking-sync'
import { prisma } from '@/lib/db'
import { requireConsole, requireAdmin } from '@/lib/session'
import { createBookingFromPayload } from '@/lib/create-booking'
import { teamMailboxesForCrew } from '@/lib/shared-mailboxes'
import { generateRoutineDates, ROUTINE_MAX_DAYS } from '@/lib/routine'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { clearBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'
import { bookingShowName } from '@/lib/display'

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

export async function GET(request: NextRequest) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Console access required' }, { status: 403 })

  // v1.230 — ?groupId=<id> → ใบในชุดนั้นทีละใบ
  //
  // ก่อนหน้านี้หน้านี้บอกได้แค่ยอดรวม ("67 ใบ · REQUESTED 20, CANCELLED 3")
  // พอมีใบล้มระหว่างอนุมัติทั้งชุดก็ไม่มีที่ไหนบอกว่าใบไหน ต้องไปไล่ในคิวงาน
  // ที่ปนกับงานอื่นทั้งหมด — ชุดงานที่มองไม่เห็นสมาชิกตัวเองคือชุดที่จัดการไม่ได้
  const groupId = request.nextUrl.searchParams.get('groupId')?.trim()
  if (groupId) {
    const items = await prisma.booking.findMany({
      where: { routineGroupId: groupId, deletedAt: null },
      select: {
        id: true, bookingCode: true, shootDate: true, status: true,
        callTime: true, estimatedWrap: true, locationName: true,
        producer: true, producerEmail: true, assignedEmails: true,
        calendarEventId: true, calendarSyncStatus: true,
      },
      orderBy: { shootDate: 'asc' },
    })
    if (items.length === 0) return NextResponse.json({ error: 'ไม่พบงานในชุดนี้' }, { status: 404 })
    return NextResponse.json({
      groupId,
      items: items.map(b => ({
        id: b.id,
        code: b.bookingCode || b.id.slice(0, 8),
        date: b.shootDate.toISOString().slice(0, 10),
        status: b.status,
        callTime: b.callTime,
        estimatedWrap: b.estimatedWrap,
        locationName: b.locationName,
        producer: b.producer,
        producerEmail: b.producerEmail,
        assignedEmails: b.assignedEmails,
        // ใบที่ CONFIRMED แต่ไม่มี event = รูที่ reconciler ปัจจุบันไม่เก็บให้
        // (มันตามเฉพาะใบที่มี guest) โชว์ตรงนี้ให้คนเห็นแทนที่จะเงียบหาย
        calendarOk: b.calendarEventId ? true : b.status === 'CONFIRMED' ? false : null,
        calendarSyncStatus: b.calendarSyncStatus,
      })),
    })
  }

  const rows = await prisma.booking.findMany({
    where: { routineGroupId: { not: null }, deletedAt: null },
    select: {
      id: true, bookingCode: true,
      routineGroupId: true, shootDate: true, status: true,
      outlet: { select: { code: true } }, program: { select: { name: true } },
      // v1.232 — ชื่อรายการอยู่ที่ episode แล้ว (booking.program = ประเภทตอน)
      // ถ้าอ่าน booking.program ตรง ๆ ทุกชุดใหม่จะขึ้นว่า "Long-form · …" เหมือนกันหมด
      // รวมถึงในกล่องยืนยัน "ลบทั้งชุด" ซึ่งเป็นการกระทำที่ย้อนยาก
      projectName: true,
      episodes: { take: 1, select: { program: { select: { name: true } } } },
    },
    orderBy: { shootDate: 'asc' },
  })

  // v1.228 — rows the "อนุมัติทั้งชุด" button may approve. Only the two statuses
  // that mean "waiting for a human": the single-approve endpoint ALSO accepts
  // COMPLETED (the sanctioned re-open path) — a wider whitelist than this one —
  // so a bulk click must never hand it a row that has since finished.
  //
  // Typed against the Prisma enum on purpose: an untyped Set<string> would keep
  // compiling after an enum rename and every has() would quietly return false,
  // emptying the list and making the button vanish with no error anywhere.
  // This repo runs `db push` on every boot, so enum edits reach prod the same day.
  const BULK_APPROVABLE = new Set<BookingStatus>(['REQUESTED', 'ASSIGNED'])

  const map = new Map<string, {
    routineGroupId: string; outlet: string; program: string
    count: number; from: string; to: string
    statuses: Record<string, number>
    // id เอาไว้ยิง · code เอาไว้ให้คนอ่านออกตอนมีใบล้ม (cuid 8 ตัวแรกหาอะไรไม่เจอเลย)
    approvable: { id: string; code: string }[]
  }>()
  for (const r of rows) {
    const id = r.routineGroupId as string
    const day = r.shootDate.toISOString().slice(0, 10)
    const entry = { id: r.id, code: r.bookingCode || r.id.slice(0, 8) }
    const g = map.get(id)
    if (!g) {
      map.set(id, {
        routineGroupId: id, outlet: r.outlet?.code || '', program: bookingShowName(r),
        count: 1, from: day, to: day, statuses: { [r.status]: 1 },
        approvable: BULK_APPROVABLE.has(r.status) ? [entry] : [],
      })
    } else {
      g.count++
      if (day < g.from) g.from = day
      if (day > g.to) g.to = day
      g.statuses[r.status] = (g.statuses[r.status] || 0) + 1
      if (BULK_APPROVABLE.has(r.status)) g.approvable.push(entry)
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
      select: { id: true, calendarEventId: true, bookingCode: true, sheetRowIndex: true },
    })
    if (rows.length === 0) return NextResponse.json({ error: 'ไม่พบงานในชุดนี้' }, { status: 404 })
    for (const r of rows) {
      if (r.calendarEventId) deleteCalendarEvent(r.calendarEventId).catch(() => {})
      clearBookingOT(r.id).catch(() => {})
      // v1.149 — mirror the cancel flows: blank col W + Status on the Sheet so
      // the bulk-cancelled rows don't keep a live-looking Status + a dead
      // Calendar Event ID (PMDC's Airtable sync merges Service Jobs by that id).
      if (r.sheetRowIndex) {
        // v1.150 — col-A key matches appendBookingRow's (bookingCode || id).
        updateBookingRow(r.bookingCode || r.id, { status: 'CANCELLED', calendarEventId: '' }).catch(() => {})
      }
    }
    // v1.201 — คืนห้องก่อน updateMany เพราะหลังจากนั้น deletedAt จะถูกตั้ง
    // แล้ว releaseRoomForBooking จะมองว่าใบถูกลบไปแล้ว
    for (const r of rows) releaseRoomForBooking(r.id, 'routine-cancelled')
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
    outletCode, programCode, episodeProgramCode, episodeTitle, category, videoType, shootType,
    callTime, estimatedWrap, locationName, locationId, producer, producerEmail,
    crewRequired, cameraCount, micCount, vanCount, videographerCount, switcherCount, notes,
    attachTeamMailboxes,
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

  // v1.232 — รหัสใบจองประกอบจาก **ชื่อรายการที่อยู่บน episode** ไม่ใช่ program ของใบจอง
  //
  // create-booking.ts ใส่ชื่อรายการลง Booking ID ก็ต่อเมื่อ programCode ของ episode
  // **ต่างจาก** ของใบจอง เพราะโมเดลคือ ใบจองเก็บ *ประเภทตอน* (L/S/A/T) ส่วน episode
  // เก็บ *ชื่อรายการ* (MNW/TSN/…) — หน้านี้เคยส่งค่าเดียวกันไปทั้งสองที่ ค่าจึงหักล้าง
  // ตัวเองแล้วได้รหัส `WLT-260923-01` ที่ไม่มีชื่อรายการ (เจอจริง 2026-09-22, 135 ใบ)
  //
  // ฟอร์มรุ่นเก่า (แท็บที่เปิดค้างไว้ก่อน deploy) ส่ง programCode เป็นชื่อรายการมาช่องเดียว
  // **ปฏิเสธ ไม่ใช่รองรับ** — "รองรับ" ในที่นี้แปลว่าปล่อยให้มันสร้างรหัสเสียแบบเดิมเงียบ ๆ
  // แยกออกได้ชัดเพราะ client ที่ถูกต้องส่ง programCode เป็นประเภทตอน = ยาว 1 ตัวเสมอ
  // และ RoutinePlanner เป็นผู้เรียกรายเดียวของ endpoint นี้ (grep ทั้งรีโปแล้ว)
  //
  // ใบที่เกิดจากบั๊กนี้ซ่อมไม่ได้ด้วย: reprogram-booking จะเห็นว่า code == bookingProgCode
  // แล้วตอบ "ไม่มีอะไรเปลี่ยน" — รหัสที่ไม่มีชื่อรายการจะติดตัวใบนั้นถาวร
  if (!episodeProgramCode && String(programCode || '').trim().length > 1) {
    return NextResponse.json(
      { error: 'ฟอร์มรุ่นเก่า — รีเฟรชหน้า /admin/routine ก่อนสร้าง (ไม่งั้นรหัสใบจองจะไม่มีชื่อรายการ)' },
      { status: 400 },
    )
  }
  const showCode = String(episodeProgramCode || programCode || '').trim()

  // เช็คซ้ำต้องถามว่า "รายการนี้มีงานวันนี้อยู่แล้วไหม" ซึ่งอยู่ที่ episode
  // ถ้าถาม program ของใบจอง (= ประเภทตอน) จะกวาด Long-form ของทุกรายการทิ้งหมด
  const existing = await prisma.booking.findMany({
    where: {
      outlet: { code: String(outletCode) },
      deletedAt: null,
      shootDate: { in: gen.dates.map(d => new Date(d)) },
      episodes: { some: { program: { code: showCode } } },
    },
    select: { shootDate: true },
  })
  const dupSet = new Set(existing.map(e => e.shootDate.toISOString().slice(0, 10)))
  const targetDates = gen.dates.filter(d => !dupSet.has(d))
  if (targetDates.length === 0) {
    return NextResponse.json({ error: 'ทุกวันมี booking อยู่แล้ว (จองซ้ำ) — ไม่มีอะไรให้สร้าง', duplicatesSkipped: dupSet.size }, { status: 400 })
  }

  // v1.235 — รายชื่อกล่องทีม **คำนวณฝั่งเซิร์ฟเวอร์** client ส่งมาแค่ boolean
  //
  // WHY. `teamMailboxesForCrew()` กรองด้วย `sharedMailboxes()` ซึ่งอ่าน
  // `process.env.SHARED_MAILBOXES` — ตัวแปรนั้นไม่มีใน bundle ฝั่งเบราว์เซอร์
  // ถ้าปล่อยให้ client ส่งลิสต์มา ตัวกรองจะไม่เคยทำงานจริงสักครั้ง (ปิดกล่องใน
  // env แล้วก็ยังโผล่) และเซิร์ฟเวอร์จะรับอีเมลอะไรก็ได้ที่ client ใส่มา
  // ให้ client ส่ง boolean แล้วฝั่งนี้ derive เองจาก crewRequired ที่มีอยู่ใน body แล้ว
  const teamBoxes = attachTeamMailboxes === true
    ? teamMailboxesForCrew(Array.isArray(crewRequired) ? crewRequired.map(String) : [])
    : []

  const title = String(episodeTitle || '').trim() || 'Routine'
  const routineGroupId = crypto.randomUUID()
  const base = {
    outletCode, programCode, category, videoType, shootType,
    callTime, estimatedWrap, locationName, locationId, producer, producerEmail,
    crewRequired, cameraCount, micCount, vanCount, videographerCount, switcherCount, notes,
    isRoutine: true,
    routineGroupId,
    episodes: [{ programCode: showCode, title, contentType: category === 'ADVERTORIAL' ? 'ADVERTORIAL' : 'ORIGINAL_CONTENT' }],
  }

  const created: string[] = []
  const failed: { date: string; error: string }[] = []
  // Sequential: keeps episode-ID sequence minting collision-free and load light.
  for (const date of targetDates) {
    const res = await createBookingFromPayload({ ...base, shootDate: date }, session.email,
      { assignedEmails: teamBoxes })
    if (res.ok) created.push(res.booking.bookingCode || res.booking.id)
    else failed.push({ date, error: res.error })
  }

  logAudit({
    actorEmail: session.email,
    action: 'routine.create',
    entityType: 'Booking',
    entityId: routineGroupId,
    changes: { routineGroupId, outletCode, programCode, episodeProgramCode: showCode, created: created.length, failed: failed.length },
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
