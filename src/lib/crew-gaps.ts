/**
 * v1.107 — "ทีมงานยังไม่ครบ" warning. A CONFIRMED booking lists the roles it needs
 * in `crewRequired` (CREW_OPTIONS), but crew are assigned as a FLAT email list
 * (`assignedEmails`) with no per-role tag. So we infer coverage by resolving each
 * assigned STAFF member's `User.position` to the crew role it fills, then flag any
 * required role that no assigned staff covers — a prompt for the queue assigner.
 *
 * Caveat: freelancers carry no position (free-text name/email only), so a role
 * filled by a freelancer can't be auto-detected — the warning is a soft HINT, not
 * a hard block. Callers surface the freelancer count so the assigner can judge.
 */

/** Thai labels for the crew roles, for the warning UI. */
export const CREW_ROLE_TH: Record<string, string> = {
  Videographer: 'ช่างวิดีโอ',
  Sound: 'ช่างเสียง',
  Photographer: 'ช่างภาพ',
  Switcher: 'สวิตเชอร์',
  DIT: 'DIT',
  Lighting: 'ช่างไฟ',
  'Virtual Production': 'Virtual Production',
  'Art Director': 'Art Director',
}

/**
 * Classify a `User.position` into the CREW_OPTIONS role it can fill, or null for
 * positions that don't man a crew slot (producers, directors, editors, managers,
 * coordinators…). Keyed off the position keywords actually used by the team.
 * Order matters: more specific checks first.
 */
export function crewRoleFromPosition(position?: string | null): string | null {
  const p = (position || '').toLowerCase()
  if (!p) return null
  if (p.includes('photo')) return 'Photographer'
  if (p.includes('sound') || p.includes('audio')) return 'Sound'
  if (p.includes('switcher')) return 'Switcher'
  if (p.includes('virtual production')) return 'Virtual Production'
  if (p.includes('art director')) return 'Art Director'
  if (p.includes('light')) return 'Lighting'
  if (/\bdit\b/.test(p)) return 'DIT'
  // "Videographer" only — NOT "Video Director" / "Video Editor" / "Video
  // Production Manager", which include "video" but don't operate a camera.
  if (p.includes('videographer')) return 'Videographer'
  return null
}

/**
 * Roles a staff member actually holds a `User.position` for, so "no staff
 * assigned" is a meaningful signal. Lighting / DIT / Art Director have NO staff
 * (always booked as freelancers, who carry no position) — tracking them would
 * flag "missing" on every such job forever, so they're left out of the warning.
 */
export const STAFF_TRACKABLE_ROLES = ['Videographer', 'Sound', 'Photographer', 'Switcher', 'Virtual Production']

/**
 * Roles in `crewRequired` that no assigned staff position covers. Limited to the
 * staff-trackable roles (see above) so freelancer-only roles don't produce
 * constant false "missing" noise. Unknown/blank required entries are ignored.
 */
export function missingCrewRoles(crewRequired: string[] | null | undefined, assignedPositions: Array<string | null | undefined>): string[] {
  const covered = new Set(assignedPositions.map(crewRoleFromPosition).filter(Boolean) as string[])
  const seen = new Set<string>()
  const out: string[] = []
  for (const role of crewRequired || []) {
    if (STAFF_TRACKABLE_ROLES.includes(role) && !covered.has(role) && !seen.has(role)) {
      seen.add(role)
      out.push(role)
    }
  }
  return out
}
