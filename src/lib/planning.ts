// v1.62.0 — pure helpers for the planning export (kept out of the route so the
// overnight-wrap duration math has one runnable check). See export-planning route.

/** Combine a date + "HH:MM" into a Bangkok-anchored Date. null if either missing/invalid. */
export function bkkAt(date: Date | string | null | undefined, time: string | null | undefined): Date | null {
  if (!date || !time) return null
  const d = new Date(date).toISOString().slice(0, 10)
  const parsed = new Date(`${d}T${time}:00+07:00`)
  return isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Duration in hours between start and end as a 1-decimal string ('' if either
 * is missing). A negative span (end clock time earlier than start on the same
 * calendar day) is treated as an overnight wrap → +24h.
 */
export function durationHours(start: Date | null, end: Date | null): string {
  if (!start || !end) return ''
  let h = (end.getTime() - start.getTime()) / 3_600_000
  if (h < 0) h += 24
  return (Math.round(h * 10) / 10).toString()
}
