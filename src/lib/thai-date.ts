/**
 * Thai / Buddhist-era date helpers (v1.134).
 *
 * The app stores and computes everything in the GREGORIAN calendar. But Thai
 * users, pasted spreadsheet cells, and some import paths sometimes carry a
 * Buddhist-era (พ.ศ.) year — 2026 → 2569 (+543). Left unnormalized, a Buddhist
 * year corrupts BOTH the displayed date AND the derived Production ID
 * (`generateEpisodeId` takes the last two digits of getFullYear(), so 2569 →
 * "69" instead of "26"). This is the single normalizer both the create path
 * and the edit path use so they can't drift.
 */

// Buddhist year 2569 = Gregorian 2026; the offset is a fixed 543 years. Any
// year at/above this threshold on a shoot booking is a pasted พ.ศ. value, never
// a real far-future Gregorian date (this app schedules weeks/months out).
export const BUDDHIST_ERA_OFFSET = 543
const BUDDHIST_YEAR_THRESHOLD = 2500

/**
 * If `d`'s (UTC) year looks like a Buddhist-era year (≥ 2500), return a new Date
 * shifted back 543 years to Gregorian; otherwise return `d` unchanged. Null/invalid
 * inputs pass through untouched. Pure — never mutates the input.
 */
export function normalizeBuddhistYear(d: Date | null | undefined): Date | null | undefined {
  if (!d || isNaN(d.getTime())) return d
  const y = d.getUTCFullYear()
  if (y < BUDDHIST_YEAR_THRESHOLD) return d
  const out = new Date(d.getTime())
  out.setUTCFullYear(y - BUDDHIST_ERA_OFFSET)
  return out
}
