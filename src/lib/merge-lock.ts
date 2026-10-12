/**
 * v1.268.1 — one merge per booking at a time.
 *
 * The hourly routes guard only against THEMSELVES (`videoMergeRunning` /
 * `soundMergeRunning`, module flags in their route files); the per-booking
 * "รวมไฟล์เข้ากล่องนี้" job (booking-merge.ts) never looked at either, so it
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
 * globalThis, not a module-level Set: the routes that share it are separate
 * Next.js entries, and one instance per process must not hang on how they bundle.
 * ponytail: in-process — every merge runs in the single web container (workers
 * only call it over HTTP). A second web replica needs reconciler/lease.ts.
 */
const g = globalThis as unknown as { __probookMergeLocks?: Set<string> }
const held = (g.__probookMergeLocks ??= new Set<string>())

export const videoMergeKey = (bookingId: string) => `video:${bookingId}`
export const soundMergeKey = (bookingId: string) => `sound:${bookingId}`

/** Take every key or none. false = someone else holds at least one. */
export function tryLockMerge(keys: string[]): boolean {
  if (keys.some(k => held.has(k))) return false
  for (const k of keys) held.add(k)
  return true
}

export function unlockMerge(keys: string[]): void {
  for (const k of keys) held.delete(k)
}
