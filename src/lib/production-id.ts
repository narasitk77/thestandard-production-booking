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

export function parseProductionId(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(EPISODE_ID_RE_LOOSE)
  return m ? m[1] : null
}

/**
 * Scan an ordered list of folder names (root → leaf, as produced by
 * `listFilesRecursive`'s `folderPath`) and return the **closest**
 * Production ID — i.e. the nearest ancestor folder whose name contains
 * a valid Production ID.
 *
 * Closest-wins because of real-world nesting like
 *   ROOT / AGN-260423-EVT-01 / Cam1 / 001.mp4
 * where the file's immediate parent is "Cam1" (no ID), the next level
 * up is "AGN-260423-EVT-01" (matches). Walking leaf → root naturally
 * picks the right one.
 *
 * Returns null when no segment matches (file lives in an unnamed
 * structure, or no folder above it has a Production ID). The sync
 * worker then records the file with `parseStatus = 'unparsed'` for
 * triage.
 */
export function findProductionIdInPath(folderPath: string[]): string | null {
  if (!folderPath || folderPath.length === 0) return null
  for (let i = folderPath.length - 1; i >= 0; i--) {
    const id = parseProductionId(folderPath[i])
    if (id) return id
  }
  return null
}
