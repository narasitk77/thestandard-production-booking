import { prisma } from './db'
import { excludeSharedMailboxes } from './shared-mailboxes'
import { parseTimeToMinutes } from './ot-calc'
import { isMonthEditable } from './ot-cleanup'
import { EPISODE_ORDER } from './episode-order'

/**
 * Auto-generate OT TASK records from a booking's assigned crew.
 *
 * Each assigned crew gets one record per booking with:
 *  - startTime = booking.callTime
 *  - endTime = booking.estimatedWrap (or callTime + 4h default)
 *  - jobTask = "[Auto] OUTLET·PROGRAM EpisodeIDs"
 *  - justification = "Auto from booking ID"
 *
 * Day-type / OT amount is computed at view time from the date + tasks list.
 *
 * Idempotent: DRAFT rows are derived data and are replaced every call. Rows the
 * crew already signed are NOT — see planBookingOTSync for the exact rule.
 */
export async function syncBookingOT(bookingId: string): Promise<{ created: number; kept: number }> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { outlet: true, program: true, episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } } },
  })
  // A booking that should carry no OT at all is the cancel path's job (and the
  // cancel path keeps closed-month signed rows too) — go through the same rule.
  if (!booking || booking.status === 'CANCELLED' || booking.deletedAt) {
    // v1.51 — never generate OT rows for soft-deleted bookings, whatever the
    // caller (defense-in-depth: assign/restore call this after their own guards)
    const r = await clearBookingOT(bookingId)
    return { created: 0, kept: r.kept }
  }

  // v1.191 — กล่องกลางของทีม (video@ / sound@ / …) ไม่ใช่คน จึงไม่ควรมีร่าง OT:
  // ไม่มีใครเป็นเจ้าของ ไม่มีใครกดส่ง ไม่มีใครเซ็น — ของจริงบนพรอดคือ 203 จาก 513
  // ใบ (40%) ตกอยู่กับ video@/sound@ ซึ่งเป็น noise ล้วน ๆ และทำให้ตัวเลข funnel
  // ของ pilot ดูแย่กว่าความจริง (คำสั่ง operator 2026-08-24: "ตัดกล่องกลางออก")
  //
  // แถว DRAFT ถูกลบ-แล้ว-สร้างใหม่ทุกครั้ง ฉะนั้นคิวที่ถูก sync อีกครั้งจะสะอาดเอง
  const emails = excludeSharedMailboxes(booking.assignedEmails || [])
  const desired: DesiredOTRow[] = []
  if (emails.length > 0 && booking.callTime) {
    const startTime = booking.callTime
    const endTime = booking.estimatedWrap || addHoursStr(startTime, 4)
    const date = new Date(booking.shootDate)
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

    // v1.42.0 — overnight shoots: when the wrap time is at/before the call time
    // the shift ran past midnight, so the OT record ends the NEXT day. Otherwise
    // endDate stays null (same-day). parseTimeToMinutes guards bad formats.
    const sMin = parseTimeToMinutes(startTime)
    const eMin = parseTimeToMinutes(endTime)
    const overnight = sMin !== null && eMin !== null && eMin <= sMin
    const endDate = overnight ? new Date(date.getTime() + 86_400_000) : null

    const epIds = booking.episodes.map(e => e.episodeId).join(', ')
    const jobTask = `[Auto] ${booking.outlet.code}·${booking.program.code}${epIds ? ` (${epIds})` : ''}`
    const justification = `Auto-generated from approved booking ${booking.id}`
    for (const email of emails) {
      desired.push({ userEmail: email.toLowerCase(), month, date, endDate, startTime, endTime, jobTask, justification })
    }
  }

  const existing = await prisma.oTRecord.findMany({
    where: { bookingId },
    select: { id: true, userEmail: true, month: true, approvalStatus: true, date: true, endDate: true, startTime: true, endTime: true },
  })
  const plan = planBookingOTSync(existing, desired, isMonthEditable)
  warnKept(bookingId, 'sync', plan.kept)

  if (plan.deleteIds.length) await prisma.oTRecord.deleteMany({ where: { id: { in: plan.deleteIds } } })
  if (plan.create.length) {
    await prisma.oTRecord.createMany({ data: plan.create.map(d => ({ ...d, bookingId })) })
  }
  return { created: plan.create.length, kept: plan.kept.length }
}

/**
 * Cancel / delete path: the booking no longer carries OT.
 *
 * Deletes everything EXCEPT rows the crew signed (SUBMITTED/APPROVED/REJECTED)
 * in a month that is already closed. Those can never be re-signed — submit and
 * approve both refuse a closed month — so deleting them destroys a signed pay
 * record for good, and a soft-delete is supposed to be undoable. They stay and
 * are logged; an admin can still delete one by hand from /ot/admin.
 */
export async function clearBookingOT(bookingId: string): Promise<{ deleted: number; kept: number }> {
  const existing = await prisma.oTRecord.findMany({
    where: { bookingId },
    select: { id: true, userEmail: true, month: true, approvalStatus: true, date: true, endDate: true, startTime: true, endTime: true },
  })
  const plan = planBookingOTSync(existing, [], isMonthEditable)
  warnKept(bookingId, 'clear', plan.kept)
  if (plan.deleteIds.length === 0) return { deleted: 0, kept: plan.kept.length }
  const result = await prisma.oTRecord.deleteMany({ where: { id: { in: plan.deleteIds } } })
  return { deleted: result.count, kept: plan.kept.length }
}

export type DesiredOTRow = {
  userEmail: string
  month: string
  date: Date
  endDate: Date | null
  startTime: string
  endTime: string
  jobTask: string
  justification: string
}

export type ExistingOTRow = {
  id: string
  userEmail: string
  month: string
  approvalStatus: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  date: Date
  endDate: Date | null
  startTime: string | null
  endTime: string | null
}

export type KeptOTRow = { id: string; userEmail: string; approvalStatus: string; month: string; stale: boolean }

/**
 * Which of a booking's existing OT rows to delete, which to keep, which to create.
 *
 * WHY (2026-11-08 maintenance): this used to be `deleteMany({ bookingId })` +
 * recreate as DRAFT. Every admin save of a booking (the edit form always sends
 * callTime), every assign — including RoutinePlanner "เพิ่มทีมงานทั้งชุด", which
 * walks every non-cancelled row of a routine group, past COMPLETED shoots
 * included — every approve and every restore wiped rows the crew had SUBMITTED
 * and managers had APPROVED, signatures and all. In a closed month the new DRAFT
 * can never be submitted again, so the approved OT was simply gone.
 *
 *  - DRAFT                         → replaced (derived data — unchanged behaviour)
 *  - signed, same times, still crew → kept as is; nothing re-created for that person
 *  - signed, closed month           → kept even when the booking changed
 *                                     (stale: true — logged); never re-created
 *  - signed, open month, changed    → replaced by a DRAFT, the crew re-signs
 *                                     (unchanged behaviour: same as an owner edit
 *                                     of a SUBMITTED row reverting it to DRAFT)
 *
 * "Same times" compares only the fields the pay is computed from (date, end
 * date, start, end). A jobTask relabel — outlet move, episode rename — is not a
 * reason to throw a signature away.
 */
export function planBookingOTSync(
  existing: readonly ExistingOTRow[],
  desired: readonly DesiredOTRow[],
  monthEditable: (month: string) => boolean,
): { deleteIds: string[]; create: DesiredOTRow[]; kept: KeptOTRow[] } {
  const want = new Map(desired.map(d => [d.userEmail.toLowerCase(), d]))
  const deleteIds: string[] = []
  const kept: KeptOTRow[] = []
  const keptEmails = new Set<string>()

  for (const r of existing) {
    if (r.approvalStatus === 'DRAFT') { deleteIds.push(r.id); continue }
    const email = r.userEmail.toLowerCase()
    const d = want.get(email)
    const same = !!d && sameTimes(r, d)
    if (same || !monthEditable(r.month)) {
      kept.push({ id: r.id, userEmail: email, approvalStatus: r.approvalStatus, month: r.month, stale: !same })
      keptEmails.add(email)
    } else {
      deleteIds.push(r.id)
    }
  }
  return { deleteIds, create: desired.filter(d => !keptEmails.has(d.userEmail.toLowerCase())), kept }
}

function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

function sameTimes(r: ExistingOTRow, d: DesiredOTRow): boolean {
  return isoDay(r.date) === isoDay(d.date)
    && isoDay(r.endDate) === isoDay(d.endDate)
    && (r.startTime || '') === d.startTime
    && (r.endTime || '') === d.endTime
}

function warnKept(bookingId: string, path: 'sync' | 'clear', kept: KeptOTRow[]) {
  // A log line, not an alert: callers are fire-and-forget and nothing reads this
  // return value yet. The rows themselves are visible on /ot/admin.
  const stale = kept.filter(k => k.stale)
  if (stale.length === 0) return
  console.warn(
    `[ot-sync] ${path} ${bookingId}: kept ${stale.length} signed OT row(s) in a closed month that no longer match the booking — fix by hand on /ot/admin if needed:`,
    stale.map(k => `${k.userEmail} ${k.approvalStatus} ${k.month}`).join(', '),
  )
}

function addHoursStr(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + hours * 60
  const eh = Math.min(23, Math.floor(total / 60))
  const em = total % 60
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
}
