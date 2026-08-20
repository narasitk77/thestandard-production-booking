/**
 * v1.181 — did the footage-ready mail reach a HUMAN ON THE JOB?
 *
 * The reason this file exists: for five weeks every liveness check said
 * footage-ready was 🟢. It was — the worker ticked every 30 min, `errors: []`,
 * 103 sends. And not one of those sends reached a producer or a camera
 * assistant, because `FOOTAGE_READY_AUDIENCE=admin` routed all of them into the
 * operator's own digest. Nothing in the system was broken; nothing in the system
 * was watching the only thing that mattered.
 *
 * So the health of this feature is not "does the worker run" but:
 *   1. of the sends that happened, how many reached someone other than the
 *      admin digest (audience misconfigured / no producer email / all crew
 *      filtered out by the `team` domain rule)
 *   2. is anything sitting with footage on Drive that will never be told about
 *      (past the lookback window = the auto path is done with it forever)
 *
 * Pure functions only — the route feeds them rows, the tests feed them fixtures.
 */

/** The digest pseudo-recipient the sender records for the operator's own copy. */
export const ADMIN_DIGEST = 'admin-digest'

export type SendRow = { bookingCode: string | null; at: Date; recipients: string[] }

export type SendStats = {
  total: number
  toTeam: number          // at least one real mailbox on the job
  adminOnly: number       // digest/Discord only — nobody on the job heard
  peopleReached: number   // distinct real mailboxes across the window
  lastAt: string | null
  lastToTeamAt: string | null
}

/**
 * A send counts as reaching the team when it names at least one real address.
 * `admin-digest` is a marker, not an address, so a row carrying only that (the
 * `admin` audience, or the "no producer email" warning path) is a send that
 * informed the operator and nobody else.
 */
export function summarizeSends(rows: SendRow[]): SendStats {
  const people = new Set<string>()
  let toTeam = 0
  let lastToTeamAt: Date | null = null
  let lastAt: Date | null = null
  for (const r of rows) {
    const real = (r.recipients || []).filter(e => e && e !== ADMIN_DIGEST && e.includes('@'))
    real.forEach(e => people.add(e.trim().toLowerCase()))
    if (real.length > 0) {
      toTeam++
      if (!lastToTeamAt || r.at > lastToTeamAt) lastToTeamAt = r.at
    }
    if (!lastAt || r.at > lastAt) lastAt = r.at
  }
  return {
    total: rows.length,
    toTeam,
    adminOnly: rows.length - toTeam,
    peopleReached: people.size,
    lastAt: lastAt ? lastAt.toISOString() : null,
    lastToTeamAt: lastToTeamAt ? lastToTeamAt.toISOString() : null,
  }
}

export type PendingBooking = {
  bookingCode: string | null
  /** The date the WORKER windows on: the later of shootDate / shootEndDate. A
   *  three-day shoot whose first day is older than the lookback is still inside
   *  the worker's `OR` clause, so comparing shootDate alone would report a live
   *  booking as permanently lost and send someone chasing a 📣 nobody needs. */
  windowDate: Date
  fileCount: number       // what the last Drive walk saw (0 = walked, nothing there)
  walkedAt: Date | null   // readyCheckedAt — null = the worker has never looked
}

export type PendingBuckets = {
  /** Footage is on Drive, still inside the window — the sweep should get to it. */
  waiting: string[]
  /** Footage is on Drive and the shoot is older than the window: the auto path
   *  will never look at it again. Someone has to press 📣 by hand. */
  agedOut: string[]
  /** Shoot is over but no walk has ever happened — starvation symptom. */
  neverWalked: string[]
}

/**
 * Split the un-notified shoots into the three states an operator can act on.
 * `lookbackDays` must be the value the WORKER is running with: this is the whole
 * point of the aged-out bucket, and a hardcoded guess would report the wrong
 * bookings as lost the moment the env changes.
 */
export function bucketPending(rows: PendingBooking[], now: Date, lookbackDays: number): PendingBuckets {
  const cutoff = now.getTime() - lookbackDays * 86_400_000
  const out: PendingBuckets = { waiting: [], agedOut: [], neverWalked: [] }
  for (const r of rows) {
    const code = r.bookingCode || '(no code)'
    const inWindow = new Date(r.windowDate).getTime() >= cutoff
    if (r.fileCount > 0) {
      ;(inWindow ? out.waiting : out.agedOut).push(code)
    } else if (!r.walkedAt && inWindow) {
      out.neverWalked.push(code)
    }
  }
  return out
}

export type HealthInput = {
  workerEnabled: boolean
  audience: string
  windowDays: number
  sends: SendStats
  pending: PendingBuckets
  shootsOver: number      // shoots that ended inside the window (the denominator)
}

/**
 * Thai one-liners, most alarming first. Empty array = nothing to say, which is
 * what a quiet cron run should print.
 */
export function footageReadyAlerts(h: HealthInput): string[] {
  const a: string[] = []
  if (!h.workerEnabled) {
    a.push('🔴 footage-ready worker ปิดอยู่ (FOOTAGE_READY_WORKER_ENABLED) — ไม่มีการแจ้งอัตโนมัติเลย')
    return a
  }
  if (h.sends.total > 0 && h.sends.toTeam === 0) {
    a.push(
      `🔴 แจ้งไป ${h.sends.total} ใบใน ${h.windowDays} วัน แต่ไม่ถึงคนในงานเลย (เข้า digest/Discord เท่านั้น) — ` +
      `เช็ค FOOTAGE_READY_AUDIENCE (ตอนนี้ = ${h.audience})`,
    )
  }
  if (h.sends.total === 0 && h.shootsOver > 0) {
    a.push(`🔴 ${h.windowDays} วันนี้ถ่ายจบ ${h.shootsOver} ใบ แต่ไม่มีการแจ้งอัตโนมัติออกไปเลย`)
  }
  if (h.pending.agedOut.length > 0) {
    a.push(
      `🟠 ${h.pending.agedOut.length} ใบมีฟุตเทจบน Drive แล้วแต่หลุดหน้าต่างแจ้งอัตโนมัติ ` +
      `ต้องกด 📣 เอง: ${h.pending.agedOut.join(', ')}`,
    )
  }
  if (h.pending.neverWalked.length > 0) {
    a.push(
      `🟠 ${h.pending.neverWalked.length} ใบถ่ายจบแล้วแต่ worker ยังไม่เคยเดินดู Drive เลย: ` +
      `${h.pending.neverWalked.join(', ')}`,
    )
  }
  if (h.sends.total > 0 && h.sends.adminOnly > 0 && h.sends.toTeam > 0) {
    a.push(`🟡 ${h.sends.adminOnly}/${h.sends.total} ใบแจ้งเข้า digest เท่านั้น (ไม่มีอีเมลคนในงาน)`)
  }
  return a
}
