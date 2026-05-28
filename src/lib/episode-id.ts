/**
 * Episode ID format: [OUT]-[YYMMDD]-[PROG]-[EE]
 * e.g., TSS-260423-EXE-01
 *
 * Rules:
 * - Immutable once created
 * - Folder-only policy (ID on folder name, not individual files)
 * - Sequence resets per shoot date per program
 */

/**
 * Anchored format: matches a string that is *exactly* a Production /
 * Episode ID. Used by parseEpisodeId for full-string validation.
 */
export const EPISODE_ID_RE = /^([A-Z]{2,4})-(\d{6})-([A-Z0-9]{1,4})-(\d{2})$/

/**
 * Non-anchored format with word boundaries — matches a Production ID
 * embedded inside a longer string (e.g. folder name `[Final] AGN-260423-EVT-01 master`).
 * Used by src/lib/production-id.ts to pull the ID out of folder names.
 *
 * Boundaries (added v1.34.4 — defensive):
 *   `(?<![A-Za-z0-9])` — char before the ID must NOT be alnum, so
 *     `XAGN-260423-EVT-01` doesn't slip through as `AGN-260423-EVT-01`.
 *     Spaces, dashes, slashes, parens, Thai chars, start-of-string all OK.
 *   `(?!\d)`          — char after must NOT be a digit, so
 *     `AGN-260423-EVT-100` doesn't get truncated to `AGN-260423-EVT-10`.
 *     Underscores, spaces, dots, dashes, end-of-string all OK.
 *
 * Lookbehind on the `A-Za-z0-9` class (not just `[A-Z0-9]`) so a lowercase
 * prefix like `xAGN-…` is also rejected — the strict format is uppercase-
 * only, and we treat near-misses as suspicious typos worth flagging.
 */
export const EPISODE_ID_RE_LOOSE = /(?<![A-Za-z0-9])([A-Z]{2,4}-\d{6}-[A-Z0-9]{1,4}-\d{2})(?!\d)/

/**
 * Lowercase-detection variant. Same shape but case-insensitive on the
 * ID body. NOT used for parsing — only by `findProductionIdInPath` to
 * surface a warning when a folder name looks like a Production ID but
 * was typed in the wrong case (so the user can fix the typo instead of
 * silently watching it land in `unparsed`).
 */
export const EPISODE_ID_RE_CASE_INSENSITIVE = /(?<![A-Za-z0-9])([A-Za-z]{2,4}-\d{6}-[A-Za-z0-9]{1,4}-\d{2})(?!\d)/

export function generateEpisodeId(
  outletCode: string,
  shootDate: Date,
  programCode: string,
  epSeq: number
): string {
  const yy = String(shootDate.getFullYear()).slice(-2)
  const mm = String(shootDate.getMonth() + 1).padStart(2, '0')
  const dd = String(shootDate.getDate()).padStart(2, '0')
  const seq = String(epSeq).padStart(2, '0')
  return `${outletCode}-${yy}${mm}${dd}-${programCode}-${seq}`
}

export function generateEpisodeIds(
  outletCode: string,
  shootDate: Date,
  programCode: string,
  count: number,
  startSeq = 1
): string[] {
  return Array.from({ length: count }, (_, i) =>
    generateEpisodeId(outletCode, shootDate, programCode, startSeq + i)
  )
}

export function parseEpisodeId(episodeId: string): {
  outletCode: string
  dateStr: string
  programCode: string
  sequence: number
  shootDate: Date
} | null {
  const match = episodeId.match(EPISODE_ID_RE)
  if (!match) return null

  const [, outletCode, dateStr, programCode, seqStr] = match
  const yy = parseInt(dateStr.slice(0, 2)) + 2000
  const mm = parseInt(dateStr.slice(2, 4)) - 1
  const dd = parseInt(dateStr.slice(4, 6))

  return {
    outletCode,
    dateStr,
    programCode,
    sequence: parseInt(seqStr),
    shootDate: new Date(yy, mm, dd),
  }
}

export function formatShootDateForId(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
