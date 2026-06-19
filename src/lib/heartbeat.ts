// Worker heartbeats — the dead-man switch. Each background worker records its
// last successful run here; health-summary + the periodic check read it so a
// silently-dead worker (app still up, worker gone) becomes a same-minute alert
// instead of hours of unnoticed downtime.
import { prisma } from './db'
import { notifyDiscord, notifyEmailDigest } from './notify'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Mirror of scripts/lib/env.js parsePositiveInt (server side, for interval envs).
function posInt(v: string | undefined, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const enabled = (v: string | undefined) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase())

export interface WorkerSpec { key: string; label: string; enabled: boolean; intervalMs: number }

/** Expected workers + their cadence, derived from the same envs start.sh uses. */
export function workerSpecs(): WorkerSpec[] {
  return [
    { key: 'calendar-reconcile', label: 'Calendar reconcile', enabled: true,
      intervalMs: Math.max(MINUTE, posInt(process.env.CALENDAR_RECONCILE_INTERVAL_MS, 10 * MINUTE)) },
    { key: 'reminders', label: 'Reminders', enabled: enabled(process.env.REMINDERS_WORKER_ENABLED),
      intervalMs: posInt(process.env.REMINDERS_WORKER_INTERVAL_MS, 24 * HOUR) },
    { key: 'footage', label: 'Footage sync', enabled: enabled(process.env.FOOTAGE_WORKER_ENABLED),
      intervalMs: posInt(process.env.FOOTAGE_WORKER_INTERVAL_MS, 10 * MINUTE) },
    { key: 'backup', label: 'DB backup', enabled: enabled(process.env.BACKUP_WORKER_ENABLED),
      intervalMs: posInt(process.env.BACKUP_INTERVAL_MS, 24 * HOUR) },
  ]
}

export async function recordHeartbeat(key: string, note?: string): Promise<void> {
  try {
    const at = new Date()
    await prisma.systemHeartbeat.upsert({
      where: { key },
      create: { key, at, note: note ?? null },
      update: { at, note: note ?? null },
    })
  } catch (e: any) {
    // Never let heartbeat bookkeeping break the actual worker run.
    console.warn(`[heartbeat] record failed for ${key}:`, e?.message || e)
  }
}

export interface WorkerHealth extends WorkerSpec { lastTick: string | null; ageMs: number | null; stale: boolean; neverTicked: boolean }

/**
 * A worker is STALE when it's enabled, has ticked before, and the last tick is
 * older than its interval + a 2-hour grace (so a daily backup alerts at ~26h, a
 * 10-min worker at ~2h). A worker that never ticked is reported (neverTicked)
 * but not treated as stale — avoids a false alarm in the window right after a
 * deploy before the first run lands.
 */
export async function evaluateWorkers(): Promise<WorkerHealth[]> {
  const rows = await prisma.systemHeartbeat.findMany()
  const byKey = new Map(rows.map((r) => [r.key, r.at]))
  const now = Date.now()
  return workerSpecs().map((s) => {
    const last = byKey.get(s.key) ?? null
    const ageMs = last ? now - last.getTime() : null
    const neverTicked = s.enabled && !last
    const stale = s.enabled && ageMs != null && ageMs > s.intervalMs + 2 * HOUR
    return { ...s, lastTick: last ? last.toISOString() : null, ageMs, stale, neverTicked }
  })
}

/**
 * Dead-man check: called from the always-on reconcile worker each run. If any
 * enabled worker has gone stale, fire ONE alert and throttle further alerts to
 * once / 6h (state stored in a heartbeat row) so it doesn't spam every cycle.
 */
export async function maybeAlertStaleWorkers(): Promise<void> {
  const stale = (await evaluateWorkers()).filter((w) => w.stale)
  if (stale.length === 0) return
  try {
    const last = (await prisma.systemHeartbeat.findUnique({ where: { key: 'alert:stale-workers' } }))?.at
    if (last && Date.now() - last.getTime() < 6 * HOUR) return // throttled
    await recordHeartbeat('alert:stale-workers', stale.map((w) => w.key).join(','))
    const lines = stale.map((w) => `• ${w.label} — last tick ${w.ageMs != null ? Math.round(w.ageMs / MINUTE) + ' min ago' : 'never'}`)
    const msg = `⚠️ Production Booking: worker(s) ไม่ตอบสนอง\n${lines.join('\n')}\nตรวจ container logs / restart stack`
    await Promise.all([notifyDiscord(msg), notifyEmailDigest('⚠️ Worker หยุดทำงาน — Production Booking', msg)])
  } catch (e: any) {
    console.warn('[heartbeat] stale-worker alert failed:', e?.message || e)
  }
}
