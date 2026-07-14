import { OUTLETS } from './data'
import { bookingDisplayName } from './display'

/**
 * Outlet code → folder name mapping.
 *
 * NOTE (v1.70, issue #5): the OUTLET_FOLDER_BY_CODE map below now only backs
 * `hasOutletFolderMapping` (the "is this outlet uploadable?" gate in
 * /api/upload/init). The Google Drive footage path moved to PMC's new
 * "VIDEO 2026 [JUL–DEC]" structure and derives outlet folders straight from
 * the OUTLETS master (`outletDriveFolderName`, "01 · News" … "09 · Content
 * Agency"). (It previously also keyed the Wasabi archive — dual-write removed.)
 *
 * The Shared Drive root (`DRIVE_FOOTAGE_ROOT`) lays out files per-outlet.
 * The folder names there don't always match the 3-letter Outlet.code in our
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
 * (`ensureChildFolderByCanonicalName` in `google-drive.ts`).
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
  EVT: 'EVENT',   // v1.99.0 — Event team
  PM: 'PM',       // v1.99.0 — Project Management Office
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
// the specials are created on demand at upload time.
export const CAM_LETTERS = ['A', 'B', 'C', 'D'] as const
export const CAMERA_SPECIALS = ['DRONE', 'SWITCHER', 'PHOTO', 'SCREEN'] as const

/**
 * Camera folders to PRE-CREATE when a booking is CONFIRMED: CAM-A..CAM-{n}
 * (capped at CAM-D), straight from the booked cameraCount. Returns [] for a
 * Block Shot / unspecified count — the shoot folder is still made; cameras
 * come at upload time via the ensure-create fallback.
 *
 * v1.147 (ops) — AUDIO is NO LONGER pre-created from micCount: sound arrives
 * via the _SOUND-STAGING → sound-merge pipeline, and the merge ensure-creates
 * its own AUDIO target (see soundDestination in sound-merge.ts), so the
 * pre-created shells just sat empty. The upload dropdown still offers AUDIO
 * (cameraUploadOptions below) and creates the folder on first use.
 */
export function camerasToPreCreate(cameraCount?: number | null): string[] {
  const n = Math.max(0, Math.min(cameraCount ?? 0, CAM_LETTERS.length))
  return CAM_LETTERS.slice(0, n).map(l => `CAM-${l}`)
}

/**
 * Camera options for the upload dropdown: CAM-A..CAM-{n} (min CAM-A so the
 * list is never empty) + AUDIO (if mics) + the always-available specials.
 * AUDIO stays selectable even though it's not pre-created anymore.
 */
export function cameraUploadOptions(cameraCount?: number | null, micCount?: number | null): string[] {
  const slots = camerasToPreCreate(cameraCount)
  const cams = slots.length > 0 ? slots : ['CAM-A']
  return [...cams, ...((micCount ?? 0) > 0 ? ['AUDIO'] : []), ...CAMERA_SPECIALS]
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
    // v1.111 — no SMB/NTFS-illegal chars: the Production Team landing folders
    // mirror to the office NAS over SMB, and a name with ":" (e.g. a job titled
    // "TSS: Interview Adver …") silently failed to sync — the folder existed on
    // Drive but never appeared on the NAS, so the crew had nowhere to dump.
    .replace(/[:*?"<>|]+/g, ' ')
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
/**
 * v1.110 — strip a trailing "logistics" parenthetical from a job name so the
 * folder reads cleanly. The [REQUEST]-migrated jobs carry van/phone/plate notes
 * in a trailing "(…)" (e.g. "วิน Souri (รถ. 1. ก.ค ทัด. 081-8018202 ฮย-3959)");
 * ops wants those removed. Only a trailing group that LOOKS like logistics
 * (contains รถ / โทร / ทัด or 2+ digits) is dropped — a legit trailing "(…)" with
 * no digits/keywords is kept.
 */
export function cleanJobName(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .replace(/\s*\([^)]*(?:รถ|โทร|ทัด|\d{2,})[^)]*\)\s*$/, '')
    .trim()
}

/**
 * Human-readable Drive folder name for a booking (v1.110):
 *   "Exclusive Interview · โบนัสสุกี้ (WLT-EXI-260701-01)"   (show + job)
 *   "The Secret Sauce (TSS-TSS-260701-01)"                   (no distinct job)
 *   "โบนัสสุกี้ (WLT-EXI-260701-01)"                          (no show passed)
 *   "WLT-EXI-260701-01"                                       (neither)
 *
 * Show name leads (so a folder is self-describing even in the flat NAS landing,
 * which has no program layer above it); the Production ID trails in parens as the
 * stable identity. `showName` should be bookingShowName(booking). Pre-v1.110
 * folders used "<code> · <job>" — see legacyBookingFolderName + folderNameMatchesCode
 * for backward-compatible lookups.
 */
export function buildBookingFolderName(bookingCode: string, jobName?: string | null, showName?: string | null): string {
  const code = String(bookingCode || '').trim()
  const job = sanitizeNameSegment(cleanJobName(jobName), 100)
  const show = sanitizeNameSegment(showName || '', 80)
  const lead = show && job && show !== job ? `${show} ${MIDDLE_DOT} ${job}` : (show || job)
  return lead ? `${lead} (${code})` : code
}

/**
 * v1.111 — LANDING folder name (the flat "Production Team" shared drive, which
 * mirrors to the office NAS). Same show-first shape as the box, but crew-facing:
 *   - uses the DISPLAY show name (episode-title fallback when the program is a
 *     generic universal Episode-Type — calendar-migrated bookings), so the NAS
 *     reads "Now (NWS-…)" instead of "Long-form · รายการ · … · Now (NWS-…)".
 *   - treats a "-" job title as empty ("Open Relationship · - (POD-…)" →
 *     "Open Relationship (POD-…)").
 * Landing lookups all match by Production ID (folderNameMatchesCode), so this
 * name is presentation-only — safe to differ from the VIDEO 2026 box name.
 */
export function landingBookingFolderName(b: {
  bookingCode: string
  projectName?: string | null
  program: { name: string }
  episodes: Array<{ title?: string | null; program?: { name: string } | null }>
}): string {
  const rawJob = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
  const job = rawJob === '-' ? null : rawJob
  return buildBookingFolderName(b.bookingCode, job, bookingDisplayName(b))
}

/**
 * Pre-v1.110 folder name ("<code> · <job>", job NOT cleaned) — kept ONLY so
 * lookups can still find folders created before the naming change, until they're
 * renamed. Never use for NEW folders.
 */
export function legacyBookingFolderName(bookingCode: string, jobName?: string | null): string {
  const code = String(bookingCode || '').trim()
  const job = sanitizeNameSegment(jobName || '', 100)
  return job ? `${code} ${MIDDLE_DOT} ${job}` : code
}

/**
 * True when a Drive folder name belongs to `bookingCode`, tolerating BOTH the
 * legacy "<code> · …" (code leads) and the v1.110 "… (<code>)" (code trails)
 * shapes. Used by the merge/detect routines that match a booking's folder by its
 * immutable Production ID rather than the full (editable) name.
 */
export function folderNameMatchesCode(name: string, bookingCode: string): boolean {
  const n = String(name || '')
  const code = String(bookingCode || '').trim()
  if (!code) return false
  return n === code || n.startsWith(code + ' ') || n.includes(`(${code})`)
}

/**
 * v1.93 — Drive folder name for ONE episode inside a booking folder:
 *   "EP01 · ชื่อตอน"   (when the episode has a title)
 *   "EP02"             (when it doesn't)
 *
 * `sequence` is 1-based (create-booking assigns idx+1). Shoots that record
 * several episodes get one such folder per EP — so footage is split per
 * episode (<booking>/<EP>/<camera>/) instead of all mixed in one camera
 * folder. Bookings with no episodes skip this layer entirely.
 */
export function buildEpisodeFolderName(
  ep: { sequence: number; title?: string | null; episodeId?: string | null },
  opts: { useEpisodeId?: boolean } = {},
): string {
  // v1.94 — Content Agency leads with the project EP ID (e.g. PP-26-008-L04),
  // which is unique within the project, so EP folders from different bookings of
  // the SAME project don't collide as siblings under the Project box. Every other
  // outlet uses the per-booking running number EP01/EP02 (safe under their own
  // per-booking <Production ID> folder).
  const lead = opts.useEpisodeId && ep.episodeId
    ? sanitizeNameSegment(ep.episodeId, 60)
    : `EP${String(ep.sequence).padStart(2, '0')}`
  const title = sanitizeNameSegment(ep.title || '', 80)
  return title ? `${lead} ${MIDDLE_DOT} ${title}` : lead
}

/** Episode Type code for a Photo Album shoot (the "A" picker option). */
export const PHOTO_ALBUM_EPISODE_CODE = 'A'

/**
 * v1.102.8 — a "Photo album" job: its output is photos, not video, so it's filed
 * in the Photographer team's Shared Drive (a flat job folder) instead of the
 * VIDEO 2026 tree. True when the booking has episodes and they're ALL the Photo
 * Album type (a pure photo job — mixed video+photo bookings stay in VIDEO 2026).
 */
export function isPhotoAlbumBooking(episodes: Array<{ program?: { code?: string | null } | null }>): boolean {
  return episodes.length > 0 && episodes.every(e => (e.program?.code || '').toUpperCase() === PHOTO_ALBUM_EPISODE_CODE)
}

/**
 * v1.108 — a booking that the Sound team works on (`crewRequired` includes 'Sound').
 * Such bookings get a Sound staging folder pre-created; the sound-merge routine
 * later folds their audio into the video box.
 */
export function bookingNeedsSound(crewRequired?: string[] | null): boolean {
  return (crewRequired || []).some(r => r === 'Sound')
}

/**
 * A folder name that embeds a Production ID (POP-7TG-260706-01, EVT-260723-01,
 * AGN-260706-LOC-01, and the legacy kept-collision NWS-260701-L-01 shape — the
 * optional segments are {1,4} chars exactly so single-letter [TYPE] codes match).
 * Staging children that DON'T match are show-category folders.
 */
export const PRODUCTION_ID_IN_NAME_RE = /[A-Z]{2,4}(?:-[A-Z0-9]{1,4})?-\d{6}(?:-[A-Z0-9]{1,4})?-\d{2}/

/**
 * v1.123 — the show-category layer inside _SOUND-STAGING
 * (`_SOUND-STAGING/<หมวดรายการ>/<booking>/`). Prefers a REAL show:
 *   1. the project name (Content Agency / client jobs),
 *   2. a per-episode show whose code is a real program (multi-char, ≠ booking-level),
 *   3. the booking-level program when it's a real show,
 *   4. the outlet display name — so a universal Episode-Type booking (program 'L'
 *      etc.) files under "News"/"Event" instead of a "Long-form · …" pseudo-show.
 * Every candidate is sanitized and must NOT itself look like a Production ID —
 * a category that matches the ID regex would be classified as a booking folder
 * by the staging lister and hide everything inside it.
 */
export function soundStagingCategoryName(b: {
  outletCode: string
  projectName?: string | null
  program: { code: string; name: string }
  episodes?: Array<{ program?: { code: string; name: string } | null }> | null
}): string {
  const ok = (raw?: string | null): string | null => {
    const s = sanitizeNameSegment(raw || '')
    return s && !PRODUCTION_ID_IN_NAME_RE.test(s) ? s : null
  }
  const isAgency = b.outletCode === 'AGN'
  // Content Agency groups by PROJECT (a client project IS its "show"). Every
  // other outlet groups by the actual show/program — projectName there is the
  // episode title, so preferring it would split one show across title/casing
  // variants (e.g. 'THE WORLD DIALOGUE' vs the program's 'The World Dialogue').
  if (isAgency) { const p = ok(b.projectName); if (p) return p }
  const real = (b.episodes || []).map(e => e.program)
    .find(p => p && p.code.trim().length > 1 && p.code !== b.program.code)
  const realName = real ? ok(real.name) : null
  if (realName) return realName
  if (b.program.code.trim().length > 1) {
    const progName = ok(b.program.name)
    if (progName) return progName
  }
  const project = ok(b.projectName) // last resort (e.g. AGN with no real show)
  if (project) return project
  const outlet = OUTLETS.find(o => o.code === b.outletCode)
  return ok(outlet?.name) || ok(b.outletCode) || 'อื่นๆ'
}

/**
 * v1.94 — the two folder layers between `<NN · Outlet>` and the EP folders.
 * They differ by outlet kind:
 *   Content Agency (AGN): footage is organised by category → PROJECT. The
 *     category box ("Advertorial" / "Event / Forum", pre-created by PMC under
 *     "09 · Content Agency") is the program layer, then a Project box
 *     "<Project ID> · <name>" replaces the per-booking folder — so every booking
 *     of a project drops its EPs in one place, grouped under the right category.
 *     (v1.94.1 — restored the category layer that the first cut dropped: ops
 *     wants Event shoots under "Event / Forum" and Advertorial under "Advertorial".)
 *   Every other outlet: "<show name>" then a per-booking "<Production ID · job>".
 */
export function shootFolderLayers(input: {
  outletCode: string
  showName: string
  category?: string | null
  projectId?: string | null
  projectName?: string | null
  bookingCode: string
  jobName?: string | null
}): { programFolderName: string; bookingFolderName: string; bookingSubfolderName?: string } {
  if (input.outletCode.toUpperCase() === 'AGN' && input.projectId) {
    return {
      // category box (Advertorial / Event · Forum) — pass category ONLY so the
      // fallback lands on "Advertorial", never the show/project name.
      programFolderName: programFolderName({ outletCode: input.outletCode, category: input.category }),
      // Project box (shared across the project's bookings, keyed by projectId) —
      // keep the legacy "<projectId> · <projectName>" shape; the v1.110 show-first
      // rename targets the per-booking/landing folders, not this shared box.
      bookingFolderName: legacyBookingFolderName(input.projectId, input.projectName),
      // v1.112 — per-BOOKING layer INSIDE the project box ("<job> (<code>)"):
      // a project runs many คิว whose EP folders used to sit as siblings in the
      // box, so nobody could tell which queue shot what. EP folders nest here.
      bookingSubfolderName: buildBookingFolderName(input.bookingCode, input.jobName),
    }
  }
  return {
    programFolderName: programFolderName({ outletCode: input.outletCode, showName: input.showName, category: input.category }),
    // v1.110 — show-first: "<show> · <job> (<code>)".
    bookingFolderName: buildBookingFolderName(input.bookingCode, input.jobName, input.showName),
  }
}

// (buildStoragePath — the per-file Wasabi archive key builder — was removed
//  along with the Wasabi dual-write. Drive is the only upload target.)
