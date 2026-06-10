/**
 * Episode ID format: [OUT]-[PROG]-[YYMMDD]-[TYPE]-[EE]
 * e.g., NWS-KYM-260616-L-01 — program segment added v1.46.0
 * (ops feedback: "รหัสรายการให้อยู่ใน Booking ID ด้วย เช่น NWS-KYM-…").
 * The legacy shape without the program segment stays valid and parseable:
 * [OUT]-[YYMMDD]-[TYPE]-[EE], e.g. TSS-260423-EXE-01, NWS-260608-L-01.
 *
 * Rules:
 * - Immutable once created
 * - Folder-only policy (ID on folder name, not individual files)
 * - Sequence resets per shoot date per outlet+program+type stream
 */

/**
 * Anchored format: matches a string that is *exactly* a Production /
 * Episode ID — with or without the program segment. Used by
 * parseEpisodeId for full-string validation.
 *
 * The optional `(?:([A-Z0-9]{2,4})-)?` program group can't steal the date:
 * it requires a trailing '-' right after 2–4 alnums, and YYMMDD is always
 * 6 chars, so on a legacy ID the group fails and `\d{6}` consumes the date.
 */
export const EPISODE_ID_RE = /^([A-Z]{2,4})-(?:([A-Z0-9]{2,4})-)?(\d{6})-([A-Z0-9]{1,4})-(\d{2})$/

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
 *
 * Matching is leftmost-first, so `NWS-KYM-260616-L-01` is captured whole
 * from `NWS`, never as the shorter `KYM-260616-L-01` tail.
 */
export const EPISODE_ID_RE_LOOSE = /(?<![A-Za-z0-9])([A-Z]{2,4}-(?:[A-Z0-9]{2,4}-)?\d{6}-[A-Z0-9]{1,4}-\d{2})(?!\d)/

/**
 * Lowercase-detection variant. Same shape but case-insensitive on the
 * ID body. NOT used for parsing — only by `findProductionIdInPath` to
 * surface a warning when a folder name looks like a Production ID but
 * was typed in the wrong case (so the user can fix the typo instead of
 * silently watching it land in `unparsed`).
 */
export const EPISODE_ID_RE_CASE_INSENSITIVE = /(?<![A-Za-z0-9])([A-Za-z]{2,4}-(?:[A-Za-z0-9]{2,4}-)?\d{6}-[A-Za-z0-9]{1,4}-\d{2})(?!\d)/

/**
 * Build an Episode / Production ID. `typeCode` is the stream
 * discriminator that has always sat before the sequence (Episode Type
 * L/S/A/T for outlet bookings, Shoot Type STD/LOC/EVT for Content
 * Agency productions). Pass `programCode` (e.g. KYM) to get the v1.46.0
 * shape with the program right after the outlet; omit it for the legacy
 * shape (Content Agency keeps omitting it — a production isn't a show).
 */
export function generateEpisodeId(
  outletCode: string,
  shootDate: Date,
  typeCode: string,
  epSeq: number,
  programCode?: string | null
): string {
  const yy = String(shootDate.getFullYear()).slice(-2)
  const mm = String(shootDate.getMonth() + 1).padStart(2, '0')
  const dd = String(shootDate.getDate()).padStart(2, '0')
  const seq = String(epSeq).padStart(2, '0')
  const prog = programCode?.trim() ? `${programCode.trim().toUpperCase()}-` : ''
  return `${outletCode}-${prog}${yy}${mm}${dd}-${typeCode}-${seq}`
}

export function generateEpisodeIds(
  outletCode: string,
  shootDate: Date,
  typeCode: string,
  count: number,
  startSeq = 1,
  programCode?: string | null
): string[] {
  return Array.from({ length: count }, (_, i) =>
    generateEpisodeId(outletCode, shootDate, typeCode, startSeq + i, programCode)
  )
}

export function parseEpisodeId(episodeId: string): {
  outletCode: string
  /** Program segment (e.g. KYM) — null on legacy IDs that don't carry one. */
  programCode: string | null
  dateStr: string
  /** The slot before the sequence: Episode Type (L/S/A/T) or Shoot Type (STD/LOC/EVT). */
  typeCode: string
  sequence: number
  shootDate: Date
} | null {
  const match = episodeId.match(EPISODE_ID_RE)
  if (!match) return null

  const [, outletCode, programCode, dateStr, typeCode, seqStr] = match
  const yy = parseInt(dateStr.slice(0, 2)) + 2000
  const mm = parseInt(dateStr.slice(2, 4)) - 1
  const dd = parseInt(dateStr.slice(4, 6))

  return {
    outletCode,
    programCode: programCode || null,
    dateStr,
    typeCode,
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
