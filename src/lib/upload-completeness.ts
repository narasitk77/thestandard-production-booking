/**
 * Upload completeness classifier — single source of truth for "is this
 * booking ready for the Mark-as-Done review?".
 *
 * A booking enters the review queue once it has at least one COMPLETE
 * Upload row with a video camera AND at least one COMPLETE Upload row
 * with sound. Files in PENDING/UPLOADING/FAILED don't count — the crew
 * can't claim coverage with a half-finished or aborted upload.
 *
 * "Sound" = camera label exactly equals 'Sound' (the dropdown option in
 * `src/lib/data.ts` CREW_OPTIONS + `src/app/_components/booking/UploadSection.tsx`
 * CAMERAS list). Everything else counts as a video stream (Cam1-4, Drone,
 * BTS, Switcher, Atem, etc).
 *
 * Used by:
 *   - GET /api/admin/upload-review — lists bookings that pass the gate
 *   - POST /api/admin/[id]/mark-upload-done — re-checks before flipping
 *     to COMPLETED so a race condition (file deleted between list+confirm)
 *     can't slip past the gate
 *   - /admin/[id] UI — shows the "Mark as Done" button conditionally
 */

const SOUND_LABELS = new Set(['sound', 'audio', 'mic'])

export function isSoundCamera(camera: string | null | undefined): boolean {
  if (!camera) return false
  return SOUND_LABELS.has(camera.trim().toLowerCase())
}

export interface UploadRow {
  camera: string
  status: string
  fileSize: bigint | number | null
}

export interface CompletenessReport {
  videoCount: number     // number of COMPLETE video uploads
  soundCount: number     // number of COMPLETE sound uploads
  inFlightCount: number  // any non-COMPLETE/non-FAILED uploads
  failedCount: number
  totalBytes: number     // sum of COMPLETE upload sizes
  hasVideo: boolean
  hasSound: boolean
  /**
   * True iff the booking has at least one COMPLETE video upload AND at
   * least one COMPLETE sound upload — and therefore is eligible for the
   * Mark-as-Done review.
   */
  isReady: boolean
}

export function assessCompleteness(uploads: UploadRow[]): CompletenessReport {
  let videoCount = 0
  let soundCount = 0
  let inFlightCount = 0
  let failedCount = 0
  let totalBytes = 0
  for (const u of uploads) {
    // v1.146 review fix — DRIVE_OK is a dead legacy status (dual-write era:
    // Drive done, Wasabi pending). Wasabi is removed, so a row stuck at
    // DRIVE_OK has its file safely in Drive — it must count as COMPLETE, not
    // sit "in-flight" forever and block the booking from ever being ready.
    // WASABI_OK is the inverse (file went only to the removed cloud) — the
    // file is unreachable, so it counts as failed rather than forever-pending.
    if (u.status === 'COMPLETE' || u.status === 'DRIVE_OK') {
      if (isSoundCamera(u.camera)) soundCount += 1
      else videoCount += 1
      if (u.fileSize != null) totalBytes += Number(u.fileSize)
    } else if (u.status === 'FAILED' || u.status === 'ORPHANED' || u.status === 'WASABI_OK') {
      failedCount += 1
    } else {
      // PENDING / UPLOADING — genuinely partial
      inFlightCount += 1
    }
  }
  const hasVideo = videoCount > 0
  const hasSound = soundCount > 0
  return {
    videoCount,
    soundCount,
    inFlightCount,
    failedCount,
    totalBytes,
    hasVideo,
    hasSound,
    isReady: hasVideo && hasSound,
  }
}
