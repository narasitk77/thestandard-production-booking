/**
 * v1.166.1 — what a booking's history may show, and to whom.
 *
 * WHY THIS EXISTS. `GET /api/bookings/:id/history` returned EVERY audit row
 * whose entityType is 'Booking' — action and `changes` payload verbatim — and
 * its only gate is `canViewBooking`, which since v1.152 returns true for any
 * signed-in user (the schedule is deliberately transparent). That is fine for
 * the booking lifecycle it was built to show, and quietly dangerous for
 * everything else: the v1.166 peer-review feature logged "a rating came in for
 * this booking, from the sound team", and since a normal shoot has exactly one
 * sound engineer, the producer who had just been rated could name their rater
 * with one authenticated GET. The promise printed on the form was already
 * broken before anyone read the code.
 *
 * The lesson generalises past that one row: any future feature that logs
 * against a booking inherits an audience of "everyone", and nobody writing that
 * feature will think to check this file. So the filter is FAIL-CLOSED — an
 * action nobody has listed is invisible to non-console users, rather than
 * exposed by default.
 *
 * Console roles keep the unfiltered view: they can already read this data on
 * the admin surfaces, and hiding it there would break real triage work.
 */

/**
 * Action prefixes a non-console viewer may see on a booking's timeline. These
 * are the booking's own lifecycle — what everyone can already infer from the
 * booking page itself, so showing WHEN it happened adds no new disclosure.
 *
 * Do NOT add a prefix here to make debugging easier. If a row is only useful to
 * staff, it belongs in the console view, which is unfiltered.
 */
export const PUBLIC_HISTORY_PREFIXES = [
  'booking.',   // create / update / status_change / delivered / cancel_requested / …
  'approve',    // the approval event itself
  'document.',  // documents attached to the booking (already visible on the page)
] as const

export function isPubliclyVisibleAction(action: string): boolean {
  const a = (action || '').trim()
  if (!a) return false
  return PUBLIC_HISTORY_PREFIXES.some(p => (p.endsWith('.') ? a.startsWith(p) : a === p))
}

/**
 * Filter a history list for the viewer. `isConsole` gets everything (unchanged
 * behaviour); everyone else gets the lifecycle subset above.
 */
export function visibleHistory<T extends { action: string }>(rows: T[], isConsole: boolean): T[] {
  if (isConsole) return rows
  return rows.filter(r => isPubliclyVisibleAction(r.action))
}
