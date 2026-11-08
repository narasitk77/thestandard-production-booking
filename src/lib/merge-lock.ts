/**
 * v1.268.1 — one merge per booking at a time.
 *
 * The hourly routes guard only against THEMSELVES (`runGuard` below, module state in their route files); the
 * per-booking "รวมไฟล์เข้ากล่องนี้" job (booking-merge.ts) never looked at it, so it
 * could run on the same booking as the hourly pass. Two sound passes both dedup
 * before either copies → every new WAV lands twice in AUDIO. Two video passes
 * race the same files, and can beat video-merge's re-check before trash: one
 * pass ensures an empty camera twin (its whole-folder move failed) and starts
 * moving files into it while the other sees it empty and trashes it — the files
 * then land inside a trashed folder.
 *
 * Keyed per booking (not one global flag) so the button is refused only while
 * the hourly pass is on THIS booking, and the hourly pass skips only the booking
 * the button holds — instead of a 409 to the worker every time someone presses it.
 *
 * globalThis, not a module-level Map: the routes that share it are separate
 * Next.js entries, and one instance per process must not hang on how they bundle.
 * ponytail: in-process — every merge runs in the single web container (workers
 * only call it over HTTP). A second web replica needs reconciler/lease.ts.
 *
 * maint 2026-11-08 — a held key EXPIRES. googleapis sets no request timeout, so one Drive call that never settles keeps its
 * merge's `finally` from running: the key stayed held for the life of the process and every hourly pass skipped
 * that booking ("merge already running…") while still ticking its heartbeat — the booking's footage never merged
 * and nobody was told. Same shape as footage-ready's boolean latch (2026-09-04, 38 × 409). A key older than
 * MERGE_LOCK_MAX_MS is taken over, loudly. The token tryLockMerge returns lets a run that outlived its lock finish
 * without freeing the run that took it over.
 * ponytail: 2 h is well past the slowest real single-booking merge seen (~30 min, AGN-260930-01's 372-folder
 * landing, 7 Oct); a merge that legitimately runs longer would be overtaken — raise it then.
 */
export const MERGE_LOCK_MAX_MS = 2 * 3_600_000

const g = globalThis as unknown as { __probookMergeLockSince?: Map<string, number> }
const held = (g.__probookMergeLockSince ??= new Map<string, number>())

export const videoMergeKey = (bookingId: string) => `video:${bookingId}`
export const soundMergeKey = (bookingId: string) => `sound:${bookingId}`

/** Take every key or none. 0 = someone else holds at least one; otherwise a token for unlockMerge. */
export function tryLockMerge(keys: string[], now = Date.now()): number {
  if (keys.some(k => { const t = held.get(k); return t !== undefined && now - t < MERGE_LOCK_MAX_MS })) return 0
  for (const k of keys) {
    const t = held.get(k)
    if (t !== undefined) console.error(`[merge-lock] ${k} ถูกถือมา ${Math.round((now - t) / 60_000)} นาทีโดยรอบที่ไม่จบ (Drive ค้าง?) — หมดอายุแล้ว รอบนี้รับต่อ`)
    held.set(k, now)
  }
  return now
}

/** `token` = what tryLockMerge returned — every merge passes it. Without it the keys are freed unconditionally (tests). */
export function unlockMerge(keys: string[], token?: number): void {
  for (const k of keys) if (token === undefined || held.get(k) === token) held.delete(k)
}

/**
 * maint 2026-11-08 — the hourly routes' "one real run at a time" guard (video-merge / sound-merge / prep-folders), with an
 * expiry. A boolean cleared only in `finally` latches for the life of the process when a Drive call never settles,
 * and every later run 409s — footage-ready 2026-09-04 (38 × 409 in 24 h, fixed there in v1.220) and landing/manage
 * (v1.149) already moved to a timestamp. start() → a token, or 0 while a live run holds it.
 * The expiry is HANG recovery, not a timeout: routes pass MERGE_LOCK_MAX_MS (never less), so a slow but live run is
 * never overlapped — the old boolean never allowed two passes at once, and the per-booking locks do not cover the
 * landing-wide steps or the non-atomic folder creates.
 */
export function runGuard(name: string, maxMs: number) {
  let since = 0
  return {
    start(now = Date.now()): number {
      if (since && now - since < maxMs) return 0
      if (since) console.error(`[${name}] รอบก่อนเริ่มไป ${Math.round((now - since) / 60_000)} นาทีแล้วยังไม่จบ (Drive ค้าง?) — ตัวกันหมดอายุ เริ่มรอบใหม่`)
      return (since = now)
    },
    /** a run that outlived its guard must not free the run that took it over */
    end(token: number): void { if (since === token) since = 0 },
  }
}
