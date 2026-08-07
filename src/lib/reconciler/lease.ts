/**
 * v1.167 — mutual exclusion for the unified reconcile pass (design §4.1–4.3).
 *
 * WHY A DB ROW AND NOT AN ADVISORY LOCK. The first design reached for
 * `pg_try_advisory_xact_lock` via `prisma.$executeRaw`. That is a NO-OP here:
 * an xact-scoped lock is released when the statement's implicit transaction
 * commits — immediately, outside an explicit `$transaction` — and Prisma's
 * pooled connections mean a later `pg_advisory_unlock` can run on a different
 * connection entirely. The v1.146 pattern works because it wraps a short
 * critical section INSIDE a transaction; a reconcile pass does minutes of Drive
 * I/O. A lease row gives real cross-process exclusion (blue/green deploys,
 * staging pointed at the wrong drive, admin tools in another process) for one
 * query per claim, releases itself on crash via TTL, and is testable with
 * ordinary Prisma.
 *
 * THE CLAIM IS A COMPARE-AND-SET, NOT A READ-THEN-WRITE. `updateMany` with the
 * staleness predicate in the WHERE clause is atomic in Postgres: exactly one
 * concurrent caller can see `count === 1`. Reading first and then writing would
 * let two passes both observe a stale lease and both proceed.
 *
 * STALENESS IS RENEWAL-BASED, NOT DURATION-BASED. A correct pass can legitimately
 * run 20+ minutes (seven workers' worth of Drive work plus 429 backoff). A
 * "expire after 15 minutes" guard would hand the lease to a second pass while
 * the first is still writing — the exact overlap this exists to prevent. So the
 * holder renews between bookings and the TTL only has to outlive one renewal
 * interval.
 */
import { prisma } from '../db'

/** How long a lease survives without a renewal. ≈5× the renewal interval. */
export const LEASE_TTL_MS = 5 * 60_000
/** Holders renew no more often than this (cheap: one indexed UPDATE). */
export const LEASE_RENEW_INTERVAL_MS = 60_000

export const PASS_LEASE_KEY = 'lease:reconciler:pass'
export function bookingLeaseKey(bookingCode: string): string {
  return `lease:booking:${bookingCode}`
}

export interface Lease {
  key: string
  runId: string
  /** Renew if due; returns false when the lease was lost (someone else owns it). */
  renew(): Promise<boolean>
  release(): Promise<void>
}

/** Pure: is a lease with this last-renewal time claimable now? */
export function isLeaseStale(renewedAt: Date | null | undefined, now: Date, ttlMs = LEASE_TTL_MS): boolean {
  if (!renewedAt) return true
  return now.getTime() - renewedAt.getTime() >= ttlMs
}

/**
 * Try to take the lease. NEVER blocks and never waits — a pass that cannot get
 * the lease logs and skips its tick, because the next tick is a minute away and
 * queueing passes behind each other is how a slow run turns into a pile-up.
 */
export async function acquireLease(key: string, runId: string, opts: { ttlMs?: number; now?: Date } = {}): Promise<Lease | null> {
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS
  const now = opts.now ?? new Date()
  const staleBefore = new Date(now.getTime() - ttlMs)

  // Fast path: steal an expired (or unrenewed) lease atomically.
  const taken = await prisma.systemHeartbeat.updateMany({
    where: { key, at: { lt: staleBefore } },
    data: { at: now, note: runId },
  })
  if (taken.count === 1) return makeLease(key, runId, ttlMs)

  // No row yet — create it. A concurrent creator wins the unique key and we
  // simply lose this tick (the v1.146 upsert-race lesson: never assume our
  // create is the only one in flight).
  try {
    await prisma.systemHeartbeat.create({ data: { key, at: now, note: runId } })
    return makeLease(key, runId, ttlMs)
  } catch {
    return null
  }
}

function makeLease(key: string, runId: string, ttlMs: number): Lease {
  let lastRenewAt = Date.now()
  return {
    key,
    runId,
    async renew() {
      if (Date.now() - lastRenewAt < LEASE_RENEW_INTERVAL_MS) return true
      // `note: runId` in the WHERE is what makes this safe: if the lease was
      // stolen while we were slow, count is 0 and the caller must stop writing.
      const r = await prisma.systemHeartbeat.updateMany({
        where: { key, note: runId },
        data: { at: new Date() },
      })
      if (r.count === 1) { lastRenewAt = Date.now(); return true }
      return false
    },
    async release() {
      // Only release OUR lease. Backdating rather than deleting keeps the row
      // (and its history) around and makes the next claim a plain CAS.
      await prisma.systemHeartbeat.updateMany({
        where: { key, note: runId },
        data: { at: new Date(Date.now() - ttlMs - 1000) },
      }).catch(() => {})
    },
  }
}

/**
 * Run `fn` while holding `key`. Returns `{ skipped: true }` when the lease is
 * held elsewhere — the caller reports that, it is not an error.
 */
export async function withLease<T>(
  key: string, runId: string, fn: (lease: Lease) => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const lease = await acquireLease(key, runId)
  if (!lease) return { skipped: true }
  try {
    return { skipped: false, result: await fn(lease) }
  } finally {
    await lease.release()
  }
}
