/**
 * Production ID = the human-readable Booking code (`Booking.bookingCode`),
 * format `[OUT]-[YYMMDD]-[PROG]-[SEQ]` — the same shape as an Episode ID.
 *
 * `parseProductionId` pulls a Production ID out of an arbitrary filename or
 * folder name. Used by the footage-sheet sync worker (v1.34.2) to map a
 * Drive file → booking record before appending a row to the footage log.
 *
 * Tolerates path prefixes, extensions, camera suffixes, and
 * underscore/dot/hyphen separators around the ID. Examples:
 *
 *   AGN-260423-EVT-01_Cam1_001.mp4           → 'AGN-260423-EVT-01'
 *   /share/footage/AGN-260423-EVT-01/RAW.MOV → 'AGN-260423-EVT-01'
 *   AGN-260423-EVT-01.mp4                    → 'AGN-260423-EVT-01'
 *   random.mp4                               → null
 *
 * Multiple IDs in one string → returns the first match (no real-world case
 * for two IDs in a name; pick deterministic-first).
 */

import { EPISODE_ID_RE_LOOSE } from './episode-id'

export function parseProductionId(filename: string | null | undefined): string | null {
  if (!filename) return null
  const m = filename.match(EPISODE_ID_RE_LOOSE)
  return m ? m[1] : null
}
