// Reminder engine — the "กันลืม" core.
//
// runReminderScan() runs daily (supervised worker → /api/internal/reminders/run).
// It detects open conditions across loans / rentals / invoices / repairs /
// upcoming shoots / warranties, upserts a Reminder row per condition keyed by a
// stable `dedupeKey` (so it never double-creates), auto-resolves rows whose
// condition has cleared, then dispatches the full open list as one digest to
// Discord + email and marks the newly-created ones SENT.
//
// Re-sending the open list each run is intentional: it keeps nagging until you
// dismiss/resolve an item — which is exactly the point for a solo admin who
// forgets. Dismiss on /admin/reminders to silence one; resolve when handled.
import { prisma } from './db'
import { notifyDiscord, notifyEmailDigest } from './notify'
import type { ReminderType } from '@prisma/client'
import { startOfTodayBangkok } from './bangkok-day'

const DAY = 86_400_000

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY)
}
function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

type Candidate = {
  type: ReminderType
  dedupeKey: string
  dueDate: Date | null
  title: string
  body?: string | null
  entityType: string
  entityId: string
}

/** Detect every currently-open condition. Pure reads — no writes. */
async function detect(today: Date): Promise<Candidate[]> {
  const out: Candidate[] = []
  const loanLookahead = envInt('LOAN_DUE_LOOKAHEAD_DAYS', 2)
  const agingDays = envInt('INVOICE_AGING_DAYS', 7)
  const repairAgingDays = envInt('REPAIR_AGING_DAYS', 7)
  const gearLookahead = envInt('SHOOT_GEAR_LOOKAHEAD_DAYS', 3)
  const warrantyLookahead = envInt('WARRANTY_LOOKAHEAD_DAYS', 30)

  // 1) Equipment loans due / overdue
  const loans = await prisma.equipmentLoan.findMany({
    where: { status: 'ACTIVE', dueDate: { not: null, lte: addDays(today, loanLookahead) } },
  })
  for (const l of loans) {
    const overdue = l.dueDate! < today
    const type: ReminderType = overdue ? 'LOAN_OVERDUE' : 'LOAN_DUE'
    out.push({
      type,
      dedupeKey: `${type}:${l.loanCode}`,
      dueDate: l.dueDate,
      title: `ยืมอุปกรณ์${overdue ? 'เกินกำหนดคืน' : 'ใกล้ครบกำหนดคืน'}: ${l.loanCode} (${l.photographer})`,
      body: [l.jobName, l.dueDate ? `กำหนดคืน ${ymd(l.dueDate)}` : null].filter(Boolean).join(' · '),
      entityType: 'EquipmentLoan',
      entityId: l.id,
    })
  }

  // 2) Rentals past return-due and not yet returned
  const rentalsDue = await prisma.rentalJob.findMany({
    where: { status: 'ACTIVE', returnedAt: null, returnDueDate: { not: null, lte: today } },
    include: { vendor: { select: { name: true } } },
  })
  for (const r of rentalsDue) {
    out.push({
      type: 'RENTAL_RETURN_DUE',
      dedupeKey: `RENTAL_RETURN_DUE:${r.id}`,
      dueDate: r.returnDueDate,
      title: `ของเช่าถึงกำหนดคืน: ${r.jobName || r.quoteNo || r.id}`,
      body: [r.vendor?.name, r.returnDueDate ? `คืนภายใน ${ymd(r.returnDueDate)}` : null].filter(Boolean).join(' · '),
      entityType: 'RentalJob',
      entityId: r.id,
    })
  }

  // 3) Invoices aging (invoiced/pending older than N days)
  const aging = await prisma.rentalJob.findMany({
    where: {
      paymentStatus: { in: ['INVOICED', 'PENDING'] },
      rentalDate: { not: null, lt: addDays(today, -agingDays) },
    },
    include: { vendor: { select: { name: true } } },
  })
  for (const r of aging) {
    out.push({
      type: 'INVOICE_AGING',
      dedupeKey: `INVOICE_AGING:${r.id}`,
      dueDate: r.rentalDate,
      title: `ใบแจ้งหนี้ค้าง (${r.paymentStatus === 'PENDING' ? 'รอจ่าย' : 'วางบิล'}): ${r.jobName || r.invoiceNo || r.quoteNo || r.id}`,
      body: [r.vendor?.name, r.amount ? `${r.amount} บาท` : null, r.rentalDate ? `ตั้งแต่ ${ymd(r.rentalDate)}` : null]
        .filter(Boolean)
        .join(' · '),
      entityType: 'RentalJob',
      entityId: r.id,
    })
  }

  // 4) Repairs still outstanding at the vendor
  const repairs = await prisma.repairTicket.findMany({
    where: { status: { in: ['REPORTED', 'SENT'] }, createdAt: { lt: addDays(today, -repairAgingDays) } },
    include: { vendor: { select: { name: true } } },
  })
  for (const t of repairs) {
    out.push({
      type: 'REPAIR_OUTSTANDING',
      dedupeKey: `REPAIR_OUTSTANDING:${t.id}`,
      dueDate: t.sentDate,
      title: `งานซ่อมค้าง: ${t.itemLabel}`,
      body: [t.vendor?.name, t.status === 'SENT' ? 'ส่งซ่อมแล้ว' : 'แจ้งซ่อม', t.sentDate ? `ส่ง ${ymd(t.sentDate)}` : null]
        .filter(Boolean)
        .join(' · '),
      entityType: 'RepairTicket',
      entityId: t.id,
    })
  }

  // 5) Upcoming shoots with no equipment allocated yet
  const upcoming = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: ['CONFIRMED', 'ASSIGNED'] },
      shootDate: { gte: today, lte: addDays(today, gearLookahead) },
    },
    select: {
      id: true,
      bookingCode: true,
      shootDate: true,
      equipmentNote: true,
      rentalGearNote: true,
      assignedEquipmentIds: true,
      outlet: { select: { name: true } },
      program: { select: { name: true } },
    },
  })
  // Gear allocated via an equipment loan tied to the booking also counts —
  // otherwise the reminder keeps nagging after the admin checked gear out.
  const loanedBookingIds = new Set<string>(
    upcoming.length
      ? (
          await prisma.equipmentLoan.findMany({
            where: { status: 'ACTIVE', bookingId: { in: upcoming.map((b) => b.id) } },
            select: { bookingId: true },
          })
        )
          .map((l) => l.bookingId)
          .filter((x): x is string => !!x)
      : [],
  )
  for (const b of upcoming) {
    const hasGear =
      (b.equipmentNote && b.equipmentNote.trim() !== '') ||
      // v1.144 — the Week Plan's เช่า field counts as gear planning too
      (b.rentalGearNote && b.rentalGearNote.trim() !== '') ||
      (b.assignedEquipmentIds?.length ?? 0) > 0 ||
      loanedBookingIds.has(b.id)
    if (hasGear) continue
    out.push({
      type: 'SHOOT_MISSING_GEAR',
      dedupeKey: `SHOOT_MISSING_GEAR:${b.id}`,
      dueDate: b.shootDate,
      title: `งานถ่ายยังไม่จัดอุปกรณ์: ${b.bookingCode || b.program?.name || b.id}`,
      body: [b.outlet?.name, b.program?.name, `ถ่าย ${ymd(b.shootDate)}`].filter(Boolean).join(' · '),
      entityType: 'Booking',
      entityId: b.id,
    })
  }

  // 6) Warranties expiring within the lookahead window
  const warranties = await prisma.equipment.findMany({
    where: { warrantyExpiresAt: { gte: today, lte: addDays(today, warrantyLookahead) } },
  })
  for (const e of warranties) {
    out.push({
      type: 'WARRANTY_EXPIRING',
      dedupeKey: `WARRANTY_EXPIRING:${e.id}`,
      dueDate: e.warrantyExpiresAt,
      title: `ประกันใกล้หมด: ${e.name}`,
      body: [e.itemId, `หมดประกัน ${ymd(e.warrantyExpiresAt)}`].filter(Boolean).join(' · '),
      entityType: 'Equipment',
      entityId: e.id,
    })
  }

  return out
}

const TYPE_HEADER: Record<ReminderType, string> = {
  LOAN_OVERDUE: '🔴 ยืมอุปกรณ์เกินกำหนด',
  LOAN_DUE: '🟡 ใกล้ครบกำหนดคืนอุปกรณ์',
  RENTAL_RETURN_DUE: '📦 ของเช่าถึงกำหนดคืน',
  INVOICE_AGING: '💸 ใบแจ้งหนี้ค้าง',
  REPAIR_OUTSTANDING: '🔧 งานซ่อมค้าง',
  SHOOT_MISSING_GEAR: '🎥 งานถ่ายยังไม่จัดอุปกรณ์',
  WARRANTY_EXPIRING: '🛡️ ประกันใกล้หมด',
}

function buildDigest(rows: Array<{ type: ReminderType; title: string; body: string | null }>): string {
  const byType = new Map<ReminderType, string[]>()
  for (const r of rows) {
    const list = byType.get(r.type) ?? []
    list.push(`• ${r.title}${r.body ? `\n   ${r.body}` : ''}`)
    byType.set(r.type, list)
  }
  const order: ReminderType[] = [
    'LOAN_OVERDUE',
    'RENTAL_RETURN_DUE',
    'INVOICE_AGING',
    'REPAIR_OUTSTANDING',
    'LOAN_DUE',
    'SHOOT_MISSING_GEAR',
    'WARRANTY_EXPIRING',
  ]
  const sections: string[] = []
  for (const t of order) {
    const list = byType.get(t)
    if (!list?.length) continue
    sections.push(`${TYPE_HEADER[t]} (${list.length})\n${list.join('\n')}`)
  }
  return sections.join('\n\n')
}

export type ReminderScanResult = {
  dryRun: boolean
  detected: number
  created: number
  resolved: number
  openCount: number
  dispatched: { discord: boolean; email: boolean } | null
  candidates?: Array<{ type: string; title: string; dueDate: string | null }>
}

export async function runReminderScan(opts: { dryRun?: boolean } = {}): Promise<ReminderScanResult> {
  const dryRun = !!opts.dryRun
  const today = startOfTodayBangkok()
  const candidates = await detect(today)

  if (dryRun) {
    return {
      dryRun: true,
      detected: candidates.length,
      created: 0,
      resolved: 0,
      openCount: candidates.length,
      dispatched: null,
      candidates: candidates.map((c) => ({ type: c.type, title: c.title, dueDate: ymd(c.dueDate) })),
    }
  }

  const now = new Date()
  const activeKeys = new Set(candidates.map((c) => c.dedupeKey))

  // Create any condition we haven't seen yet (PENDING). skipDuplicates guards
  // against a race where the row already exists.
  const existing = await prisma.reminder.findMany({
    where: { dedupeKey: { in: candidates.map((c) => c.dedupeKey) } },
    select: { dedupeKey: true },
  })
  const have = new Set(existing.map((e) => e.dedupeKey))
  const toCreate = candidates.filter((c) => !have.has(c.dedupeKey))
  if (toCreate.length) {
    await prisma.reminder.createMany({
      data: toCreate.map((c) => ({
        type: c.type,
        dedupeKey: c.dedupeKey,
        dueDate: c.dueDate,
        title: c.title,
        body: c.body ?? null,
        entityType: c.entityType,
        entityId: c.entityId,
      })),
      skipDuplicates: true,
    })
  }

  // Auto-resolve open reminders whose condition has cleared (loan returned,
  // invoice paid, gear assigned, etc.) so the inbox doesn't accumulate stale rows.
  const open = await prisma.reminder.findMany({
    where: { status: { in: ['PENDING', 'SENT'] } },
    select: { id: true, dedupeKey: true },
  })
  const staleIds = open.filter((r) => !activeKeys.has(r.dedupeKey)).map((r) => r.id)
  if (staleIds.length) {
    await prisma.reminder.updateMany({
      where: { id: { in: staleIds } },
      data: { status: 'RESOLVED', resolvedAt: now },
    })
  }

  // Dispatch the full still-open list (PENDING or already-SENT-but-unresolved).
  const openReminders = await prisma.reminder.findMany({
    where: { status: { in: ['PENDING', 'SENT'] } },
    orderBy: [{ dueDate: 'asc' }],
  })

  let dispatched: { discord: boolean; email: boolean } | null = null
  if (openReminders.length) {
    const body = buildDigest(openReminders.map((r) => ({ type: r.type, title: r.title, body: r.body })))
    const subject = `⏰ เตือนงานค้าง ${openReminders.length} รายการ — ${ymd(today)}`
    const text = `${subject}\n\n${body}\n\n— Production Booking · /admin/reminders`
    const [discord, email] = await Promise.all([notifyDiscord(text), notifyEmailDigest(subject, text)])
    dispatched = { discord, email }
    // Mark the freshly-created PENDING ones as SENT (already-SENT rows keep their timestamp).
    await prisma.reminder.updateMany({
      where: { status: 'PENDING' },
      data: { status: 'SENT', sentAt: now },
    })
  }

  return {
    dryRun: false,
    detected: candidates.length,
    created: toCreate.length,
    resolved: staleIds.length,
    openCount: openReminders.length,
    dispatched,
  }
}
