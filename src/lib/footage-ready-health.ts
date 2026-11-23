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
  /** v1.290 — nas_sync_state lastPending for this code, read the way the sweep's gate (d) reads it
   *  (fresh manifest only). >0 = a forced run?codes= stops at the NAS gate before it looks at Drive. */
  nasPending?: number
  /** v1.290 — last shoot day is older than the daily footage check walks (FOOTAGE_INTEGRITY_DAYS):
   *  fileCount is whatever the cache last saw, nobody re-walks it. */
  pastCheck?: boolean
}

/**
 * v1.274 — why the AUTO path is holding a notice back, remembered on the booking
 * (`readySnapshot.held`, written by the sweep when the MEDIAPRO gate refuses).
 * `fileCount` is the walk's count at that moment: if the footage changed since,
 * the reason is stale and must not be repeated as fact.
 */
export type HeldNote = { detail: string; at: string; fileCount: number; totalBytes: number }

function asHeldNote(h: Partial<HeldNote> | null | undefined): HeldNote | null {
  if (!h || typeof h.detail !== 'string' || typeof h.at !== 'string' || typeof h.fileCount !== 'number' || typeof h.totalBytes !== 'number') return null
  return { detail: h.detail, at: h.at, fileCount: h.fileCount, totalBytes: h.totalBytes }
}

export function readHeld(snapshot: unknown): HeldNote | null {
  return asHeldNote((snapshot as { held?: Partial<HeldNote> } | null | undefined)?.held)
}

/**
 * maint 23 Nov 2026 — the fast path's own MEDIAPRO verdict (`readySnapshot.fast`, written one sweep after the footage
 * settles) when it found files SHORT (`incomplete: true`) — not "no MEDIAPRO to compare" or another blocker. `held` is
 * written only after the full 4 h settle, so until then the 📣 preview had nothing to warn with (LIF-ECO-261118-01:
 * fast said "การ์ด Sony ไม่มี MEDIAPRO.XML" 3.5 h before held did).
 */
export function readFastHeld(snapshot: unknown): HeldNote | null {
  const f = (snapshot as { fast?: Partial<HeldNote> & { incomplete?: unknown } } | null | undefined)?.fast
  return f?.incomplete === true ? asHeldNote(f) : null
}

/** The hold still describes the footage only if count AND bytes are unchanged since (a re-copied clip changes bytes). */
export function heldStill(h: HeldNote | null | undefined, fileCount: number, totalBytes: number): HeldNote | null {
  return h && h.fileCount === fileCount && h.totalBytes === totalBytes ? h : null
}

/**
 * v1.290 — the hold the 📣 preview reports. null = the sweep never held it. A hold whose footage changed since is
 * still returned, flagged `stale`: changed footage is not evidence the box is complete (NWS-KYM-261026-01: held at
 * 20 files, 1,019 after editors added exports, MEDIAPRO still missing) — hiding it let 📣 go out with no warning.
 */
export function previewHeld(snapshot: unknown, fileCount: number, totalBytes: number): (HeldNote & { stale?: true }) | null {
  // maint 23 Nov 2026 — falls back to the fast path's "MEDIAPRO incomplete" verdict (readFastHeld); whichever still
  // describes the footage wins, else the hold comes back flagged stale
  const notes = [readHeld(snapshot), readFastHeld(snapshot)].filter((n): n is HeldNote => !!n)
  if (!notes.length) return null
  return notes.find(n => heldStill(n, fileCount, totalBytes)) ?? { ...notes[0], stale: true }
}

/** v1.290 — the warning both 📣 confirm dialogs put first ('' = no hold). The button runs no MEDIAPRO gate. */
export function heldConfirmWarning(held: { detail?: unknown; at?: unknown; stale?: unknown } | null | undefined, code?: string | null): string {
  if (!held || typeof held.detail !== 'string' || !held.detail) return ''
  if (held.stale) {
    return `⚠️ ไฟล์เปลี่ยนหลังตรวจ (เดิมถูกถือเพราะ ${held.detail}) — ตรวจซ้ำด้วย footage-ready/run?dryRun=1&codes=${code || '<code>'} ก่อนกด\n` +
      'ปุ่มนี้ไม่ตรวจ MEDIAPRO — ส่งตอนนี้ทีมอาจได้แจ้งว่าพร้อมทั้งที่ยังขาดไฟล์\n\n'
  }
  return `⚠️ ระบบอัตโนมัติยังไม่แจ้ง เพราะไฟล์ไม่ครบ (ตรวจ ${String(held.at || '').slice(0, 10)}): ${held.detail}\nส่งตอนนี้ = ทีมจะได้แจ้งว่าพร้อมทั้งที่ยังขาดไฟล์\n\n`
}

export type PendingBuckets = {
  /** Footage is on Drive, still inside the window — the sweep should get to it. */
  waiting: string[]
  /** Footage is on Drive and the shoot is older than the window: the auto path
   *  will never look at it again. v1.290 — someone has to run footage-ready/run?codes=
   *  (every gate incl. MEDIAPRO); 📣 only after a dry-run says it would notify — the button gates nothing. */
  agedOut: string[]
  /** v1.274 — aged out AND the sweep's MEDIAPRO gate was holding it: pressing 📣 would
   *  announce incomplete footage — the button does not gate. v1.290 — `stale`: the footage
   *  changed after that check, so the reason may be old; it stays here (re-check with a
   *  dry-run) instead of falling back to "press 📣" (NWS-KYM-261026-01: held at 20 files,
   *  1,019 after editors added exports, MEDIAPRO still missing). */
  agedOutHeld: Array<{ code: string; detail: string; at: string; stale?: true }>
  /** v1.290 — aged out AND the NAS still reports files pending for this code: a forced
   *  run?codes= meets gate (d) first ("nas-still-sending" unless what is parked there is already on
   *  Drive), so this is not "files on Drive, press 📣". */
  agedOutNas: Array<{ code: string; pending: number }>
  /** v1.290 — the aged-out codes above (any of the three) whose last shoot day is past the
   *  daily footage check: their file counts are an old cache. */
  pastCheck: string[]
  /** Shoot is over but no walk has ever happened — starvation symptom. */
  neverWalked: string[]
}

/** How old an un-walked shoot must be before silence counts as starvation. */
export const COLD_AFTER_MS = 18 * 60 * 60_000

/**
 * v1.290 — the instant the WORKER stops sweeping a booking whose last shoot day is `windowDate`.
 * runReadySweep filters `shootDate/shootEndDate >= now − lookback` on @db.Date columns and Prisma
 * truncates that bound to its UTC date, so day D is swept through D+lookback inclusive = until
 * (D+lookback+1) 00:00Z. The old millisecond cutoff (now − lookback) declared a booking aged out
 * ~24 h before the worker let go of it.
 */
export function sweptUntil(windowDate: Date, lookbackDays: number): number {
  const d = new Date(windowDate)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (lookbackDays + 1) * 86_400_000
}

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
  const out: PendingBuckets = { waiting: [], agedOut: [], agedOutHeld: [], agedOutNas: [], pastCheck: [], neverWalked: [] }
  for (const r of rows) {
    const code = r.bookingCode || '(no code)'
    const at = new Date(r.windowDate).getTime()
    const inWindow = now.getTime() < sweptUntil(r.windowDate, lookbackDays)
    if (r.fileCount > 0) {
      // Footage exists — worth mailing even for a job the sweep skips, so the
      // by-design skip must NOT suppress these buckets.
      if (inWindow) { out.waiting.push(code); continue }
      if (r.pastCheck) out.pastCheck.push(code)
      // the order the sweep's gates run in: (d) NAS stops a forced run before (g) MEDIAPRO is looked at
      if ((r.nasPending || 0) > 0) out.agedOutNas.push({ code, pending: r.nasPending! })
      else if (r.held) {
        // v1.290 — a hold whose footage changed since is NOT evidence the box is complete: fail closed
        const still = heldStill(r.held, r.fileCount, r.totalBytes ?? -1)
        out.agedOutHeld.push({ code, detail: r.held.detail, at: r.held.at, ...(still ? {} : { stale: true as const }) })
      } else out.agedOut.push(code)
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
  /** v1.290 — FOOTAGE_INTEGRITY_DAYS, for the "past the daily check" count */
  checkDays: number
  /** v1.290 — nas_sync_state could not be read: an aged-out booking may be stuck at the NAS gate unseen */
  nasError?: string | null
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
  // v1.290 — (d) the stats query reaches back further than the daily check (FOOTAGE_READY_AGED_OUT_DAYS);
  // say how many of each list are counted from a cache nobody re-walks any more
  const past = new Set(h.pending.pastCheck)
  const pastNote = (codes: string[]) => {
    const n = codes.filter(c => past.has(c)).length
    return n > 0 ? ` · ในนี้ ${n} ใบถ่ายเกิน ${h.checkDays} วัน (ตรวจฟุตเทจรายวันไม่เดินซ้ำแล้ว — จำนวนไฟล์เป็นค่าเก่า)` : ''
  }
  if (h.pending.agedOut.length > 0) {
    // v1.290 — not "press 📣": the button checks only that files exist (no MEDIAPRO, no NAS)
    // NAS unreadable: some of these may be stuck at gate (d) unseen. Since maint 23 Nov 2026 the sweep holds every
    // candidate on a failed NAS read (freshNasState) instead of reading it as "gate off" — still, a dry run first
    const how = h.nasError
      ? `· ⚠️ อ่านสถานะ NAS ไม่ได้ (${h.nasError.slice(0, 80)}) — ไม่รู้ว่าใบไหนค้างด่าน NAS: ` +
        `รอจนอ่านสถานะ NAS ได้ แล้วตรวจก่อนด้วย footage-ready/run?dryRun=1&codes=<code> · อย่าเพิ่งรัน run?codes= จริงหรือกด 📣`
      : `· ตรวจ+ส่งด้วย footage-ready/run?codes=<code> (ผ่านทุกด่านรวม MEDIAPRO = ส่งเอง) ` +
        `· จะกด 📣 เองต้องให้ run?dryRun=1&codes=<code> บอกว่าจะแจ้งก่อน (ปุ่มไม่ตรวจ MEDIAPRO)`
    a.push(
      `🟠 ${h.pending.agedOut.length} ใบมีฟุตเทจบน Drive แล้วแต่หลุดหน้าต่างแจ้งอัตโนมัติ: ${h.pending.agedOut.join(', ')} ` +
      how + pastNote(h.pending.agedOut),
    )
  }
  if (h.pending.agedOutNas.length > 0) {
    a.push(
      `🟠 ${h.pending.agedOutNas.length} ใบหลุดหน้าต่างแจ้งอัตโนมัติ และ NAS ยังรายงานไฟล์ค้างส่ง — ด่าน NAS ของ run?codes= อาจกันอยู่ อย่ากด 📣: ` +
      h.pending.agedOutNas.map(x => `${x.code} (ค้าง ${x.pending} ไฟล์)`).join(' · ') +
      ` · ดูว่าผ่านด่าน NAS ไหม: footage-ready/run?dryRun=1&codes=<code> · เทียบไฟล์ NAS กับ Drive: /api/admin/nas-sync-report?verify=1` +
      pastNote(h.pending.agedOutNas.map(x => x.code)),
    )
  }
  if (h.pending.agedOutHeld.length > 0) {
    a.push(
      `🟠 ${h.pending.agedOutHeld.length} ใบหลุดหน้าต่างแจ้งอัตโนมัติ และด่าน MEDIAPRO กันไว้ (ไฟล์ไม่ครบ) — อย่าเพิ่งกด 📣 ` +
      `(ปุ่มไม่ตรวจ MEDIAPRO ทีมจะได้แจ้งว่าพร้อมทั้งที่ขาดไฟล์): ` +
      h.pending.agedOutHeld.map(x => `${x.code} — ${x.detail.slice(0, 140)} (ตรวจ ${x.at.slice(0, 10)}` +
        (x.stale ? ` · ไฟล์เปลี่ยนหลังตรวจ เหตุผลนี้อาจเก่า → ตรวจซ้ำ footage-ready/run?dryRun=1&codes=${x.code})` : ')')).join(' · ') +
      (h.nasError
        // same reason as agedOut above: the NAS state is unknown — a dry run first, never a real run
        ? ` · ⚠️ อ่านสถานะ NAS ไม่ได้ — ถ้าไฟล์มาครบแล้ว รอจนอ่านสถานะ NAS ได้ แล้วตรวจก่อนด้วย footage-ready/run?dryRun=1&codes=<code>`
        : ` · ถ้าไฟล์มาครบแล้ว: footage-ready/run?codes=<code> ตรวจซ้ำ (ครบ = ส่งเอง)`) +
      pastNote(h.pending.agedOutHeld.map(x => x.code)),
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
