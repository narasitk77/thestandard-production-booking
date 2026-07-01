/**
 * Episode ID format (v1.109): [OUT]-[PROG]-[YYMMDD]-[EE]  e.g. NWS-KYM-260616-01
 * The [TYPE] segment (Episode Type L/S/A/T · Shoot Type STD/LOC/EVT) was dropped
 * per ops. Older IDs that still carry a [TYPE] — [OUT]-[PROG]-[YYMMDD]-[TYPE]-[EE]
 * and the program-less [OUT]-[YYMMDD]-[TYPE]-[EE] — stay valid and parseable
 * (type is an OPTIONAL segment in the regexes below).
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
export const EPISODE_ID_RE = /^([A-Z]{2,4})-(?:([A-Z0-9]{2,4})-)?(\d{6})(?:-([A-Z0-9]{1,4}))?-(\d{2})$/

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
export const EPISODE_ID_RE_LOOSE = /(?<![A-Za-z0-9])([A-Z]{2,4}-(?:[A-Z0-9]{2,4}-)?\d{6}(?:-[A-Z0-9]{1,4})?-\d{2})(?!\d)/

/**
 * Lowercase-detection variant. Same shape but case-insensitive on the
 * ID body. NOT used for parsing — only by `findProductionIdInPath` to
 * surface a warning when a folder name looks like a Production ID but
 * was typed in the wrong case (so the user can fix the typo instead of
 * silently watching it land in `unparsed`).
 */
export const EPISODE_ID_RE_CASE_INSENSITIVE = /(?<![A-Za-z0-9])([A-Za-z]{2,4}-(?:[A-Za-z0-9]{2,4}-)?\d{6}(?:-[A-Za-z0-9]{1,4})?-\d{2})(?!\d)/

/**
 * Build an Episode / Production ID: [OUT]-[PROG?]-[YYMMDD]-[NN].
 * v1.109 — the [TYPE] segment (Episode Type L/S/A/T for outlet bookings, Shoot
 * Type STD/LOC/EVT for Content Agency) was dropped per ops. Pass `programCode`
 * (e.g. KYM) for the [OUT]-[PROG]-[YYMMDD]-[NN] shape; omit it for
 * [OUT]-[YYMMDD]-[NN] (Content Agency productions — a production isn't a show).
 * Sequence is per outlet+program+date (see create-booking.ts) so no [TYPE] is
 * needed to keep IDs unique. Old IDs that still carry a [TYPE] remain parseable.
 */
export function generateEpisodeId(
  outletCode: string,
  shootDate: Date,
  epSeq: number,
  programCode?: string | null
): string {
  const yy = String(shootDate.getFullYear()).slice(-2)
  const mm = String(shootDate.getMonth() + 1).padStart(2, '0')
  const dd = String(shootDate.getDate()).padStart(2, '0')
  const seq = String(epSeq).padStart(2, '0')
  const prog = programCode?.trim() ? `${programCode.trim().toUpperCase()}-` : ''
  return `${outletCode}-${prog}${yy}${mm}${dd}-${seq}`
}

export function parseEpisodeId(episodeId: string): {
  outletCode: string
  /** Program segment (e.g. KYM) — null on legacy IDs that don't carry one. */
  programCode: string | null
  dateStr: string
  /** Legacy slot before the sequence (Episode Type L/S/A/T or Shoot Type STD/LOC/EVT); null on new IDs that dropped it. */
  typeCode: string | null
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
    typeCode: typeCode || null,
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
