/**
 * v1.170 — the numbers behind the operator's monitoring panel.
 *
 * The person who owns this system needs to answer four questions in one glance,
 * every morning:
 *   1. which shoots are due a review form today?
 *   2. did it actually go out?
 *   3. is anybody answering?
 *   4. is anything stuck?
 *
 * Pure functions so every threshold is pinned by a test — a KPI that quietly
 * changes definition is worse than no KPI.
 */

export type InviteRow = {
  bookingId: string
  email: string
  sentAt: Date
  mailedAt: Date | null
  submittedAt: Date | null
}

export type OpsHealth = 'ok' | 'warn' | 'bad'

/**
 * Response rate over a set of invites. Counts only invites that were actually
 * DELIVERED — an unmailed invite is our failure, not the crew's, and folding it
 * in makes the team look unresponsive for a bug on our side.
 */
export function responseRate(invites: InviteRow[]): { sent: number; answered: number; pct: number | null } {
  const sent = invites.filter(i => i.mailedAt).length
  const answered = invites.filter(i => i.mailedAt && i.submittedAt).length
  return { sent, answered, pct: sent > 0 ? Math.round((answered / sent) * 100) : null }
}

/** Invites we created but never managed to email — the operator's to-do list. */
export function undelivered(invites: InviteRow[]): InviteRow[] {
  return invites.filter(i => !i.mailedAt)
}

/** Delivered, unanswered, and how long they have been waiting. */
export function awaitingReply(invites: InviteRow[], now: Date): Array<InviteRow & { waitingDays: number }> {
  return invites
    .filter(i => i.mailedAt && !i.submittedAt)
    .map(i => ({ ...i, waitingDays: Math.floor((now.getTime() - i.mailedAt!.getTime()) / 86_400_000) }))
    .sort((a, b) => b.waitingDays - a.waitingDays)
}

/**
 * Traffic light for the response rate.
 *
 * Thresholds are deliberately forgiving: a peer review is voluntary and a 60%
 * return is healthy for one. Setting the bar where it flatters us would make
 * the light useless; setting it at 90% would make it permanently red and
 * therefore ignored.
 */
export function rateHealth(pct: number | null): OpsHealth {
  if (pct === null) return 'ok'          // nothing sent yet is not a problem
  if (pct >= 60) return 'ok'
  if (pct >= 30) return 'warn'
  return 'bad'
}

/** Anything undelivered at all is a real failure — it is our bug, not a trend. */
export function deliveryHealth(undeliveredCount: number): OpsHealth {
  return undeliveredCount === 0 ? 'ok' : 'bad'
}

// ── feedback tickets ────────────────────────────────────────────────────────

export type TicketRow = {
  status: string
  createdAt: Date
  resolvedAt: Date | null
  lastMessageAt: Date
}

/** Hours from report to close, median — the mean is wrecked by one old ticket. */
export function medianResolveHours(tickets: TicketRow[]): number | null {
  const hrs = tickets
    .filter(t => t.resolvedAt)
    .map(t => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3_600_000)
    .sort((a, b) => a - b)
  if (hrs.length === 0) return null
  const mid = Math.floor(hrs.length / 2)
  const v = hrs.length % 2 ? hrs[mid] : (hrs[mid - 1] + hrs[mid]) / 2
  return Math.round(v * 10) / 10
}

/**
 * The number that actually matters: how long has the OLDEST unanswered report
 * been sitting? An average hides the one person who has been ignored for a week.
 */
export function oldestOpenDays(tickets: TicketRow[], now: Date): number | null {
  const open = tickets.filter(t => t.status !== 'RESOLVED')
  if (open.length === 0) return null
  const oldest = Math.min(...open.map(t => t.createdAt.getTime()))
  return Math.floor((now.getTime() - oldest) / 86_400_000)
}

/**
 * SLA light for the queue. "NEW and older than 2 days" means somebody reported
 * a problem and nobody has even acknowledged it — that is the failure mode this
 * whole ticket system was built to end.
 */
export function queueHealth(tickets: TicketRow[], now: Date): OpsHealth {
  const untouchedDays = tickets
    .filter(t => t.status === 'NEW')
    .map(t => (now.getTime() - t.createdAt.getTime()) / 86_400_000)
  if (untouchedDays.length === 0) return 'ok'
  const worst = Math.max(...untouchedDays)
  if (worst >= 2) return 'bad'
  if (worst >= 1) return 'warn'
  return 'ok'
}

/**
 * The send window the nightly job will act on next: shoots whose LAST day was
 * `delayDays` ago. Mirrors the sender exactly so the panel cannot promise a
 * batch the worker will not pick up.
 */
export function dueShootDay(now: Date, delayDays: number): Date {
  const d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - delayDays)
  return d
}
