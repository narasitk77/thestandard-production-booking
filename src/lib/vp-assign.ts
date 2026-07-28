// v1.156.1 — Virtual Production auto-assign helpers, shared by server code
// (create-booking, approve) and client code (admin workspace).
//
// A VP booking seeds assignedEmails with the VP developer at CREATE time. That
// seed is a system action, not an admin crew decision — so every surface that
// asks "did an admin assign crew yet?" (unassigned filters/counts, calendar
// requireAttendees strictness) must look through it, or VP bookings silently
// vanish from the needs-crew workflow (review finding, v1.156.1).

export const VP_ASSIGNEE_DEFAULT = 'assawapol.t@thestandard.co'

/**
 * The VP auto-assignee. Server respects VP_ASSIGNEE_EMAIL; in client bundles
 * non-NEXT_PUBLIC env is compiled out, so the browser always sees the default.
 * If you ever override the env, the workspace filter keeps using the default —
 * acceptable drift for an internal tool, noted here so it isn't a surprise.
 */
export function vpAssigneeEmail(): string {
  return (process.env.VP_ASSIGNEE_EMAIL || VP_ASSIGNEE_DEFAULT).trim()
}

/**
 * assignedEmails minus the VP auto-seed — i.e. the crew an ADMIN actually
 * picked. Non-VP bookings return the list untouched: the VP developer can be
 * manually assigned to a normal shoot, and that IS an admin decision.
 */
export function adminAssignedEmails(
  assignedEmails: string[] | null | undefined,
  virtualProduction: boolean | null | undefined,
): string[] {
  const list = (assignedEmails || []).filter(e => typeof e === 'string' && e.trim() !== '')
  if (!virtualProduction) return list
  const vp = vpAssigneeEmail().toLowerCase()
  return list.filter(e => e.trim().toLowerCase() !== vp)
}
