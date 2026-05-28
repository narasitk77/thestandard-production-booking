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

import { EPISODE_ID_RE_LOOSE, EPISODE_ID_RE_CASE_INSENSITIVE } from './episode-id'

/**
 * Normalize a string before matching it against EPISODE_ID_RE_LOOSE.
 * Catches common "accidents" that would otherwise cause a strict-format
 * miss:
 *   - macOS autocorrect: en dash (U+2013) and em dash (U+2014) → ASCII '-'
 *   - Non-breaking hyphen (U+2011) → ASCII '-'
 *   - Trim leading/trailing whitespace (does NOT affect inner matches)
 *
 * Deliberately does NOT lowercase or uppercase — case-mismatch is
 * a typo signal that gets surfaced separately by the
 * `looksLikeProductionId` helper below.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[–—‑]/g, '-')  // – — ‑ → -
    .trim()
}

export function parseProductionId(text: string | null | undefined): string | null {
  if (!text) return null
  const m = normalizeForMatch(text).match(EPISODE_ID_RE_LOOSE)
  return m ? m[1] : null
}

/**
 * Detect a string that LOOKS like a Production ID but failed strict
 * parsing — used by the sync worker to emit a triage warning when a
 * folder is named `agn-260423-evt-01` (lowercase typo) so the operator
 * can fix the folder name instead of watching it sit in `unparsed`
 * forever.
 *
 * Returns the normalized-case ID if it would have matched the strict
 * regex when uppercased, OR null if the string is genuinely unrelated.
 */
export function looksLikeProductionId(text: string | null | undefined): string | null {
  if (!text) return null
  // Already passes strict? Then it's not a "look-alike" — return null
  // (caller wouldn't call this on a known-good string anyway).
  const norm = normalizeForMatch(text)
  if (EPISODE_ID_RE_LOOSE.test(norm)) return null
  const m = norm.match(EPISODE_ID_RE_CASE_INSENSITIVE)
  return m ? m[1].toUpperCase() : null
}

/**
 * Scan an ordered list of folder names (root → leaf, as produced by
 * `listFilesRecursive`'s `folderPath`) and return:
 *   - the **closest** strict-match Production ID, OR null if none
 *   - any look-alike folder names along the way (lowercase / near-miss),
 *     so the caller can log them for triage
 *
 * Closest-wins because of real-world nesting like
 *   ROOT / AGN-260423-EVT-01 / Cam1 / 001.mp4
 * where the file's immediate parent is "Cam1" (no ID), the next level
 * up is "AGN-260423-EVT-01" (matches). Walking leaf → root naturally
 * picks the right one.
 */
export interface PathMatchResult {
  productionId: string | null
  /** Folder names that look like Production IDs but failed strict parse. */
  lookAlikes: Array<{ folder: string; normalized: string }>
}

export function findProductionIdInPath(folderPath: string[]): PathMatchResult {
  const result: PathMatchResult = { productionId: null, lookAlikes: [] }
  if (!folderPath || folderPath.length === 0) return result

  for (let i = folderPath.length - 1; i >= 0; i--) {
    const folder = folderPath[i]
    const id = parseProductionId(folder)
    if (id) {
      if (!result.productionId) result.productionId = id
      // keep scanning to collect look-alikes for triage (multi-ID paths)
      continue
    }
    const looksLike = looksLikeProductionId(folder)
    if (looksLike) result.lookAlikes.push({ folder, normalized: looksLike })
  }
  return result
}
