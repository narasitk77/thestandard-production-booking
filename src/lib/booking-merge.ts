/**
 * v1.111 — per-booking "consolidate into the box" pipeline, used by the upload
 * page's single "รวมไฟล์เข้ากล่องนี้" button. Runs the two merge steps for ONE
 * booking, in the order the ops team expects:
 *
 *   1. VIDEO — MOVE the NAS "Production Team" landing footage into the VIDEO 2026
 *      box (mirrors the camera/EP subtree). MOVE, so the landing empties.
 *   2. SOUND — fold the staged audio (_SOUND-STAGING) into the box AUDIO folder
 *      (COPY, dedup by name+size; staging stays the durable master).
 *
 * Scoped to a single booking so it returns fast (no system-wide Drive walk → no
 * 60s reverse-proxy timeout), unlike the admin-wide runVideoMerge/runSoundMerge
 * sweeps that the hourly workers use.
 */
import { mergeBookingVideo, type BookingVideoMergeResult } from './video-merge'
import { mergeBookingSound, type BookingSoundMergeResult } from './sound-merge'

// Prisma select for a booking passed to runBookingMerge: the fields both merge
// steps need, plus the access fields the route uses for canViewBooking().
export const BOOKING_MERGE_SELECT = {
  id: true,
  driveFolders: true,
  bookingCode: true,
  projectId: true,
  projectName: true,
  category: true,
  crewRequired: true,
  createdByEmail: true,
  producerEmail: true,
  assignedEmails: true,
  outlet: { select: { code: true } },
  program: { select: { name: true } },
  episodes: {
    orderBy: { sequence: 'asc' },
    select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } },
  },
} as const

type MergeBooking = Parameters<typeof mergeBookingVideo>[0] & Parameters<typeof mergeBookingSound>[0]

export interface BookingMergeResult {
  bookingCode: string | null
  dryRun: boolean
  video: BookingVideoMergeResult
  sound: BookingSoundMergeResult
  boxFolderUrl: string | null
}

export async function runBookingMerge(booking: MergeBooking, opts: { dryRun?: boolean } = {}): Promise<BookingMergeResult> {
  const dryRun = !!opts.dryRun
  // Video FIRST (move NAS footage into the box), THEN sound (fold staging → AUDIO).
  const video = await mergeBookingVideo(booking, { dryRun })
  const sound = await mergeBookingSound(booking, { dryRun })
  return {
    bookingCode: booking.bookingCode,
    dryRun,
    video,
    sound,
    boxFolderUrl: video.boxFolderUrl ?? sound.boxFolderUrl ?? null,
  }
}

// ── v1.113.4 — background merge jobs ────────────────────────────────────────
// A big landing (hundreds of camera-card files) takes several MINUTES to move
// file-by-file; the reverse proxy cuts the request at 60s, so the UI showed
// "รวมไฟล์ไม่สำเร็จ (HTTP 504)" while the move actually kept running server-side.
// So: POST now STARTS a detached job and returns at once; the UI polls GET for
// status. In-memory registry — a container restart forgets (and kills) the job;
// the button simply starts a fresh one (merge is idempotent/resumable: moved
// files are gone from the landing, a re-run handles the remainder).

export interface MergeJobStatus {
  running: boolean
  done: boolean
  startedAt: string | null
  finishedAt: string | null
  result?: BookingMergeResult
  error?: string
}

type MergeJob = {
  startedAt: string
  finishedAt: string | null
  done: boolean
  result?: BookingMergeResult
  error?: string
}

const mergeJobs = new Map<string, MergeJob>()

export function getMergeJobStatus(bookingId: string): MergeJobStatus {
  const j = mergeJobs.get(bookingId)
  if (!j) return { running: false, done: false, startedAt: null, finishedAt: null }
  return { running: !j.done, done: j.done, startedAt: j.startedAt, finishedAt: j.finishedAt, result: j.result, error: j.error }
}

/** Start (or join, when one is already running) the background merge. */
export function startMergeJob(bookingId: string, booking: MergeBooking, onDone?: () => Promise<void>): MergeJobStatus {
  const existing = mergeJobs.get(bookingId)
  if (existing && !existing.done) return getMergeJobStatus(bookingId) // running — join
  const job: MergeJob = { startedAt: new Date().toISOString(), finishedAt: null, done: false }
  mergeJobs.set(bookingId, job)
  ;(async () => {
    try {
      job.result = await runBookingMerge(booking)
      if (onDone) await onDone().catch(() => {})
    } catch (e: any) {
      job.error = e?.message || String(e)
      console.error('[booking-merge] background job failed:', bookingId, job.error)
    } finally {
      job.done = true
      job.finishedAt = new Date().toISOString()
    }
  })()
  return getMergeJobStatus(bookingId)
}
