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
  /** The worker skips photo-album bookings permanently, so their readyCheckedAt
   *  stays null forever. Counting those as "never walked" is a nag that can
   *  never be resolved — WLT-OTH-260819-01 (lighting for ID photos) was the
   *  first alert this endpoint ever produced, and it was wrong. */
  skippedByDesign?: boolean
  /** The date the WORKER windows on: the later of shootDate / shootEndDate. A
   *  three-day shoot whose first day is older than the lookback is still inside
   *  the worker's `OR` clause, so comparing shootDate alone would report a live
   *  booking as permanently lost and send someone chasing a 📣 nobody needs. */
  windowDate: Date
  fileCount: number       // what the last Drive walk saw (0 = walked, nothing there)
  walkedAt: Date | null   // readyCheckedAt — null = the worker has never looked
  /** v1.274 — the sweep's last MEDIAPRO hold (readySnapshot.held), if any, and the bytes to judge it by */
  held?: HeldNote | null
  totalBytes?: number
}

/**
 * v1.274 — why the AUTO path is holding a notice back, remembered on the booking
 * (`readySnapshot.held`, written by the sweep when the MEDIAPRO gate refuses).
 * `fileCount` is the walk's count at that moment: if the footage changed since,
 * the reason is stale and must not be repeated as fact.
 */
export type HeldNote = { detail: string; at: string; fileCount: number; totalBytes: number }

export function readHeld(snapshot: unknown): HeldNote | null {
  const h = (snapshot as { held?: Partial<HeldNote> } | null | undefined)?.held
  if (!h || typeof h.detail !== 'string' || typeof h.at !== 'string' || typeof h.fileCount !== 'number' || typeof h.totalBytes !== 'number') return null
  return { detail: h.detail, at: h.at, fileCount: h.fileCount, totalBytes: h.totalBytes }
}

/** The hold still describes the footage only if count AND bytes are unchanged since (a re-copied clip changes bytes). */
export function heldStill(h: HeldNote | null | undefined, fileCount: number, totalBytes: number): HeldNote | null {
  return h && h.fileCount === fileCount && h.totalBytes === totalBytes ? h : null
}

export type PendingBuckets = {
  /** Footage is on Drive, still inside the window — the sweep should get to it. */
  waiting: string[]
  /** Footage is on Drive and the shoot is older than the window: the auto path
   *  will never look at it again. Someone has to press 📣 by hand. */
  agedOut: string[]
  /** v1.274 — aged out AND the sweep's MEDIAPRO gate was holding it (footage unchanged
   *  since): pressing 📣 would announce incomplete footage — the button does not gate. */
  agedOutHeld: Array<{ code: string; detail: string; at: string }>
  /** Shoot is over but no walk has ever happened — starvation symptom. */
  neverWalked: string[]
}

/** How old an un-walked shoot must be before silence counts as starvation. */
export const COLD_AFTER_MS = 18 * 60 * 60_000

/**
 * Split the un-notified shoots into the three states an operator can act on.
 * `lookbackDays` must be the value the WORKER is running with: this is the whole
 * point of the aged-out bucket, and a hardcoded guess would report the wrong
 * bookings as lost the moment the env changes.
 *
 * `coldAfterMs` keeps today's shoots out of `neverWalked`: right after wrap the
 * crew may still be uploading (the sweep skips those on purpose), and a booking
 * that is merely young is not being starved.
 */
export function bucketPending(
  rows: PendingBooking[],
  now: Date,
  lookbackDays: number,
  coldAfterMs: number = COLD_AFTER_MS,
): PendingBuckets {
  const cutoff = now.getTime() - lookbackDays * 86_400_000
  const out: PendingBuckets = { waiting: [], agedOut: [], agedOutHeld: [], neverWalked: [] }
  for (const r of rows) {
    const code = r.bookingCode || '(no code)'
    const at = new Date(r.windowDate).getTime()
    const inWindow = at >= cutoff
    if (r.fileCount > 0) {
      // Footage exists — worth mailing even for a job the sweep skips, so the
      // by-design skip must NOT suppress these two buckets.
      const held = heldStill(r.held, r.fileCount, r.totalBytes ?? -1)
      if (inWindow) out.waiting.push(code)
      else if (held) out.agedOutHeld.push({ code, detail: held.detail, at: held.at })
      else out.agedOut.push(code)
    } else if (!r.walkedAt && inWindow && !r.skippedByDesign && now.getTime() - at >= coldAfterMs) {
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
  if (h.pending.agedOutHeld.length > 0) {
    a.push(
      `🟠 ${h.pending.agedOutHeld.length} ใบหลุดหน้าต่างแจ้งอัตโนมัติ และไฟล์ยังไม่ครบ — อย่าเพิ่งกด 📣 ` +
      `(ปุ่มไม่ตรวจ MEDIAPRO ทีมจะได้แจ้งว่าพร้อมทั้งที่ขาดไฟล์): ` +
      h.pending.agedOutHeld.map(x => `${x.code} — ${x.detail.slice(0, 140)} (ตรวจ ${x.at.slice(0, 10)})`).join(' · ') +
      ` · ถ้าไฟล์มาครบแล้ว: footage-ready/run?codes=<code> ตรวจซ้ำ (ครบ = ส่งเอง)`,
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
