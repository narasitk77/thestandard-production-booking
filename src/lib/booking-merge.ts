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
