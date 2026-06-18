import { OUTLETS } from './data'

/**
 * Outlet code → folder name mapping.
 *
 * NOTE (v1.70, issue #5): the OUTLET_FOLDER_BY_CODE map below is now used
 * ONLY for the Wasabi archive key (ASCII-stable, keyed by Production ID).
 * The Google Drive footage path moved to PMC's new "VIDEO 2026 [JUL–DEC]"
 * structure and derives outlet folders straight from the OUTLETS master
 * (`outletDriveFolderName`, "01 · News" … "09 · Content Agency"), so the two
 * storages no longer drift.
 *
 * The Shared Drive root (`DRIVE_FOOTAGE_ROOT`) and the Wasabi key prefix
 * (`WASABI_KEY_PREFIX`) both lay out files per-outlet. The folder names
 * in those storages don't always match the 3-letter Outlet.code in our
 * DB — historical naming choices the team made before this app existed.
 * This module is the single source of truth that the upload code consults
 * when computing the destination path.
 *
 * v1.36.0 — the team's real Shared Drive "VIDEO 2026" lays its outlet
 * folders out with an ORDERING prefix the producers re-number over time:
 *
 *   1.NEWS · 2.POP · 3.PODCAST · 4.KND · 5.THE SECRET SAUCE ·
 *   6.WEALTH · 7.LIFE · 8.SPORT · 9.ADVERTORIAL
 *
 * We must drop new footage into THOSE existing folders, not create a
 * fresh one. So the values below are the CANONICAL suffix (no "N."
 * prefix); the Drive layer matches an existing child folder whose name
 * equals this suffix after the numeric prefix is stripped
 * (`ensureChildFolderByCanonicalName` in `google-drive.ts`). Wasabi keeps
 * using the canonical name directly (no renumbering problem there).
 *
 * Confirmed against the live Drive on 2026-06-02 (inspect-drive-outlets):
 *   AGN → "ADVERTORIAL"        (folder "9.ADVERTORIAL")
 *   TSS → "THE SECRET SAUCE"   (folder "5.THE SECRET SAUCE")
 *   POP → "POP"                (folder "2.POP")
 *   NWS → "NEWS"               (folder "1.NEWS")
 *   WLT → "WEALTH"             (folder "6.WEALTH")
 *   SPT → "SPORT"              (folder "8.SPORT")
 *   POD → "PODCAST"            (folder "3.PODCAST")
 *   KND → "KND"                (folder "4.KND")
 *   LIF → "LIFE"               (folder "7.LIFE")
 *
 * If a new outlet is added later, append a line here. The numeric prefix
 * in Drive is matched fuzzily, so you only need the suffix to be right.
 */

const OUTLET_FOLDER_BY_CODE: Record<string, string> = {
  AGN: 'ADVERTORIAL',
  TSS: 'THE SECRET SAUCE',
  POP: 'POP',
  NWS: 'NEWS',
  WLT: 'WEALTH',
  SPT: 'SPORT',
  POD: 'PODCAST',
  KND: 'KND',
  LIF: 'LIFE',
}

/**
 * Resolve the canonical storage folder name for an outlet code. Falls
 * back to the raw code when the mapping is missing — better than silently
 * using the wrong folder, and the inspect script + the upload UI surface
 * the gap for triage.
 */
export function outletFolderName(outletCode: string): string {
  return OUTLET_FOLDER_BY_CODE[outletCode.toUpperCase()] ?? outletCode.toUpperCase()
}

/**
 * Does this code have a confirmed mapping, or are we just falling back
 * to the code itself? Used by the upload init endpoint to warn the
 * operator (or refuse) when an unmapped outlet attempts an upload.
 */
export function hasOutletFolderMapping(outletCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTLET_FOLDER_BY_CODE, outletCode.toUpperCase())
}

/* =============================================================================
   v1.70 (issue #5) — Google Drive footage path for the new "VIDEO 2026
   [JUL–DEC]" structure:  <root>/<NN · Outlet>/<program|category>/<ProdID · job>/<CAM-x>/
   PMC pre-creates the <NN · Outlet> and <program/category> boxes; the app
   creates the shoot + camera folders at CONFIRMED / upload time.
   ============================================================================= */

// U+00B7 MIDDLE DOT — the exact separator PMC uses in the Drive tree.
const MIDDLE_DOT = '·'

/**
 * Drive outlet folder name from the OUTLETS master (single source of truth):
 *   "01 · News" … "09 · Content Agency". The number is the outlet's `sort`
 *   (stable even if the array is reordered). Falls back to the bare code.
 */
export function outletDriveFolderName(outletCode: string): string {
  const o = OUTLETS.find(x => x.code === outletCode.toUpperCase())
  if (!o) return outletCode.toUpperCase()
  return `${String(o.sort).padStart(2, '0')} ${MIDDLE_DOT} ${o.name}`
}

/**
 * The "program / รายการ" layer between outlet and shoot.
 *   - Content Agency (AGN): keyed off the booking `category` —
 *       ADVERTORIAL → "Advertorial", EVENT → "Event / Forum"
 *       (other categories fall back to the show name, then "Advertorial").
 *   - Every other outlet: the real show name (e.g. "Key Message"), no code.
 * `showName` should be the resolved bookingShowName(booking).
 * AGN strings are returned VERBATIM (the "Event / Forum" slash is intentional
 * and must byte-match PMC's box); non-AGN names are sanitized.
 */
export function programFolderName(input: {
  outletCode: string
  showName?: string | null
  category?: string | null
}): string {
  if (input.outletCode.toUpperCase() === 'AGN') {
    const cat = String(input.category || '').toUpperCase()
    if (cat === 'ADVERTORIAL') return 'Advertorial'
    if (cat === 'EVENT') return 'Event / Forum'
    return sanitizeNameSegment(input.showName || '') || 'Advertorial'
  }
  return sanitizeNameSegment(input.showName || '') || 'รายการ'
}

// Full camera vocab (issue #5). CAM-A..D are pre-created from cameraCount;
// AUDIO from micCount; the specials are created on demand at upload time.
export const CAM_LETTERS = ['A', 'B', 'C', 'D'] as const
export const CAMERA_SPECIALS = ['DRONE', 'SWITCHER', 'PHOTO', 'SCREEN'] as const

/**
 * Camera folders to PRE-CREATE when a booking is CONFIRMED: CAM-A..CAM-{n}
 * (capped at CAM-D) + AUDIO when micCount > 0. Returns [] for a Block Shot /
 * unspecified count — the shoot folder is still made; cameras come at upload
 * time via the ensure-create fallback.
 */
export function camerasToPreCreate(cameraCount?: number | null, micCount?: number | null): string[] {
  const n = Math.max(0, Math.min(cameraCount ?? 0, CAM_LETTERS.length))
  const cams = CAM_LETTERS.slice(0, n).map(l => `CAM-${l}`)
  if ((micCount ?? 0) > 0) cams.push('AUDIO')
  return cams
}

/**
 * Camera options for the upload dropdown: CAM-A..CAM-{n} (min CAM-A so the
 * list is never empty) + AUDIO (if mics) + the always-available specials.
 */
export function cameraUploadOptions(cameraCount?: number | null, micCount?: number | null): string[] {
  const slots = camerasToPreCreate(cameraCount, micCount)
  const cams = slots.some(s => s.startsWith('CAM-')) ? slots : ['CAM-A', ...slots]
  return [...cams, ...CAMERA_SPECIALS]
}

/**
 * Sanitize a string for safe use as a single Drive folder / file name.
 * Drive itself tolerates almost anything (it keys on ids, not paths), but
 * a clean name keeps the tree readable and avoids surprises in tools that
 * later sync these folders. Keeps Thai + alphanumerics + a few separators;
 * collapses whitespace; strips path separators; caps the length.
 */
export function sanitizeNameSegment(raw: string, maxLen = 120): string {
  const cleaned = String(raw || '')
    .replace(/[\\/]+/g, ' ')      // no path separators
    .replace(/[\r\n\t]+/g, ' ')   // no line breaks
    .replace(/\s+/g, ' ')         // collapse whitespace
    .trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen).trim()
}

/**
 * Human-readable Drive folder name for a booking:
 *   "AGN-260529-STD-01 - PTTPLC ปตท."   (when a job name is known)
 *   "AGN-260529-STD-01"                  (when it isn't)
 *
 * The Production ID always leads so the folder sorts + searches by the
 * code the team uses, with the producer's job name appended for humans.
 */
export function buildBookingFolderName(bookingCode: string, jobName?: string | null): string {
  const code = String(bookingCode || '').trim()
  const job = sanitizeNameSegment(jobName || '', 100)
  return job ? `${code} ${MIDDLE_DOT} ${job}` : code
}

/**
 * Build the per-file Wasabi key components. Wasabi has no renumbering
 * problem and we want keys to stay stable + ASCII-clean, so it uses the
 * canonical outlet name and the bare bookingCode for the booking segment
 * (NOT the human "code - job name" Drive folder).
 *
 *   buildStoragePath('AGN', 'AGN-260423-EVT-01', 'Cam1', '001.mp4')
 *     → ['ADVERTORIAL', 'AGN-260423-EVT-01', 'Cam1', '001.mp4']
 *
 * Caller joins with '/' for the Wasabi key.
 */
export function buildStoragePath(
  outletCode: string,
  bookingCode: string,
  camera: string,
  filename: string,
): string[] {
  return [
    outletFolderName(outletCode),
    bookingCode,
    camera,
    filename,
  ]
}
