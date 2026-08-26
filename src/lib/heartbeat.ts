// Worker heartbeats — the dead-man switch. Each background worker records its
// last successful run here; health-summary + the periodic check read it so a
// silently-dead worker (app still up, worker gone) becomes a same-minute alert
// instead of hours of unnoticed downtime.
import { prisma } from './db'
import { notifyChat, notifyEmailDigest } from './notify'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Mirror of scripts/lib/env.js parsePositiveInt (server side, for interval envs).
function posInt(v: string | undefined, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const enabled = (v: string | undefined) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase())
/**
 * The other half of the convention: some workers are ON unless explicitly
 * switched off. Mirrors the guard at the top of each script — keep the two in
 * step, because a spec that disagrees with its script is worse than no spec
 * (it reports a worker as healthy-because-disabled while it is actually dead).
 */
const enabledUnlessOff = (v: string | undefined) => !['0', 'false', 'no'].includes(String(v || '').toLowerCase())

export interface WorkerSpec { key: string; label: string; enabled: boolean; intervalMs: number }

/**
 * Expected workers + their cadence, derived from the same envs start.sh uses.
 *
 * CAUTION when the `workers` compose profile is ever enabled (v1.168): this
 * function runs in the WEB process and reads the WEB container's env. A worker
 * flag set only on the `worker` service would make the web side compute
 * `enabled: false` and quietly switch that worker's dead-man off — the failure
 * this whole file exists to prevent. Set the enable flags on BOTH services, or
 * on the shared stack env.
 */
export function workerSpecs(): WorkerSpec[] {
  return [
    { key: 'calendar-reconcile', label: 'Calendar reconcile', enabled: true,
      intervalMs: Math.max(MINUTE, posInt(process.env.CALENDAR_RECONCILE_INTERVAL_MS, 10 * MINUTE)) },
    { key: 'reminders', label: 'Reminders', enabled: enabled(process.env.REMINDERS_WORKER_ENABLED),
      intervalMs: posInt(process.env.REMINDERS_WORKER_INTERVAL_MS, 24 * HOUR) },
    { key: 'footage', label: 'Footage sync', enabled: enabled(process.env.FOOTAGE_WORKER_ENABLED),
      intervalMs: posInt(process.env.FOOTAGE_WORKER_INTERVAL_MS, 10 * MINUTE) },
    // v1.108 — sound-merge is ON by default (off only when explicitly disabled).
    { key: 'sound-merge', label: 'Sound merge', enabled: !['0', 'false', 'no'].includes(String(process.env.SOUND_MERGE_WORKER_ENABLED || '').toLowerCase()),
      intervalMs: posInt(process.env.SOUND_MERGE_INTERVAL_MS, HOUR) },
    // v1.127 — video-merge is ON by default. Expected cadence = the worst case of
    // both worker modes: gated mode is bounded by the fallback re-run (default 6h),
    // plain mode by the hourly interval — so a stale heartbeat also catches a
    // wedged NAS gate (DSM unreachable → no runs at all).
    { key: 'video-merge', label: 'Video merge', enabled: !['0', 'false', 'no'].includes(String(process.env.VIDEO_MERGE_WORKER_ENABLED || '').toLowerCase()),
      intervalMs: posInt(process.env.VIDEO_MERGE_FALLBACK_MS, 6 * HOUR) },
    { key: 'backup', label: 'DB backup', enabled: enabled(process.env.BACKUP_WORKER_ENABLED),
      intervalMs: posInt(process.env.BACKUP_INTERVAL_MS, 24 * HOUR) },
    // v1.204 — ตัวกวาดการจองห้องในระบบกลางให้ตรงกับคิวถ่าย (ปลดห้องค้าง/จองที่ขาด)
    // ต้องมี spec ที่นี่ ไม่งั้น worker ตายแล้วห้องค้างสะสมโดยไม่มีใครรู้ — ซึ่งเป็น
    // อาการเดียวกับที่ worker ตัวนี้ถูกสร้างมาเพื่อแก้
    { key: 'room-booking-reconcile', label: 'Room booking reconcile', enabled: enabled(process.env.ROOM_BOOKING_WORKER_ENABLED),
      intervalMs: posInt(process.env.ROOM_BOOKING_WORKER_INTERVAL_MS, HOUR) },
    // v1.147 — auto "footage ready" notification sweep.
    { key: 'footage-ready', label: 'Footage ready notify', enabled: enabled(process.env.FOOTAGE_READY_WORKER_ENABLED),
      intervalMs: posInt(process.env.FOOTAGE_READY_INTERVAL_MS, 30 * MINUTE) },

    // v1.172 — the five workers that ran for months with NO dead-man cover. All
    // five do real Drive work; until now the only way to notice one had died was
    // for a human to miss the folders it should have made.
    //
    // The daily ones declare a 24h interval, so the +2h grace in evaluateWorkers
    // alerts at ~26h: one missed run is caught, and a run that lands a couple of
    // hours late (the hour gate drifts with restarts) is not a false alarm.
    { key: 'prep-folders', label: 'Prep folders', enabled: enabledUnlessOff(process.env.PREP_FOLDERS_WORKER_ENABLED),
      // The script floors this at 5 min (Math.max(300_000, …)); mirror that or a
      // bad env value would give us a stale window shorter than the real cadence.
      intervalMs: Math.max(5 * MINUTE, posInt(process.env.PREP_FOLDERS_INTERVAL_MS, HOUR)) },
    { key: 'folder-integrity', label: 'Folder integrity', enabled: enabledUnlessOff(process.env.FOLDER_INTEGRITY_WORKER_ENABLED),
      intervalMs: posInt(process.env.FOLDER_INTEGRITY_INTERVAL_MS, HOUR) },
    { key: 'shoot-marker', label: '_SHOOT marker reconcile', enabled: enabled(process.env.SHOOT_MARKER_WORKER_ENABLED),
      intervalMs: 24 * HOUR },
    { key: 'landing', label: 'Landing drop folders', enabled: enabledUnlessOff(process.env.LANDING_WORKER_ENABLED),
      intervalMs: 24 * HOUR },
    { key: 'shoot-review', label: 'Post-shoot review invites', enabled: enabled(process.env.SHOOT_REVIEW_ENABLED),
      intervalMs: 24 * HOUR },
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
    // v1.152.2 — 'ops': worker health is not footage news, so it stays off
    // Discord by default and reaches the admin by email.
    await Promise.all([notifyChat(msg, 'ops'), notifyEmailDigest('⚠️ Worker หยุดทำงาน — Production Booking', msg)])
  } catch (e: any) {
    console.warn('[heartbeat] stale-worker alert failed:', e?.message || e)
  }
}
