/**
 * v1.90 — UI tiers: collapse (role × position) into the 5 experience tiers the
 * ops team asked for, and decide which pages/menus each tier may open. One
 * source of truth used by BOTH the Nav (hide items) and the middleware (block +
 * redirect), so menu and access can never drift apart.
 *
 *   admin        ADMIN / SUPPORT / MANAGER          → everything
 *   coordinator  COORDINATOR                        → full booking queue
 *   sound-mgmt   position "Senior Sound Engineer"   → the queue (sound-focused)
 *   producer     position contains "producer"       → My Bookings / Producer
 *   crew         everyone else (Videographer/Sound/  → Upload job task
 *                Switcher/Director/Editor/…)
 */
export type Tier = 'admin' | 'coordinator' | 'sound-mgmt' | 'producer' | 'crew'

export function resolveTier(role?: string | null, position?: string | null): Tier {
  const pos = (position || '').toLowerCase()
  if (role === 'ADMIN' || role === 'SUPPORT' || role === 'MANAGER') return 'admin'
  // Sound lead — focused on the sound queue even though they hold a COORDINATOR
  // role. Checked before the plain COORDINATOR branch on purpose.
  if (pos.includes('senior sound')) return 'sound-mgmt'
  if (role === 'COORDINATOR') return 'coordinator'
  if (pos.includes('producer')) return 'producer' // Producer + Co-Producer
  return 'crew'
}

/** Landing page / redirect target when a tier hits a page it can't open. */
export function tierHome(tier: Tier): string {
  switch (tier) {
    case 'producer': return '/my-bookings'
    case 'crew': return '/upload'
    case 'sound-mgmt': return '/admin'
    default: return '/'
  }
}

// Allowed everywhere for any signed-in tier. /dashboard/[id] (booking detail) and
// /bookings/[id]/edit (producer self-edit) are linked from /my-bookings and already
// authorize by OWNER at the data/API layer (canViewBooking / isOwner+REQUESTED), so
// the tier gate must not block them — doing so locked producers/crew out of their own
// bookings (v1.92.1 fix). /new (the booking wizard) is "for everyone" per the page
// itself + POST /api/bookings (session-only); blocking it for the crew tier trapped
// brand-new USER-role users (no roster row → /upload dead-ends too) with no way to
// request a booking. v1.102.5 hid the CTA as a band-aid; this is the root fix.
// '/booking' (singular: the post-submit success/confirmation screen) and '/ot'
// (self-service overtime — gated by ot/layout.tsx to roster + approvers) are
// reachable by everyone, like '/new': blocking them at the tier gate trapped
// non-admin tiers after submitting a booking, and locked the roster out of
// recording their own OT. Their own layouts/APIs do the real authorization.
const ALWAYS = ['/calendar', '/my-bookings', '/profile', '/manual', '/changelog', '/dashboard', '/bookings', '/booking', '/new', '/ot']
// Extra path prefixes each non-admin tier may open.
const ALLOW: Record<Exclude<Tier, 'admin'>, string[]> = {
  coordinator: ['/admin', '/ot', '/upload', '/new', '/producer', '/dashboard'],
  'sound-mgmt': ['/admin'],
  producer: ['/producer', '/new'],
  crew: ['/upload'],
}
// Sub-paths a tier may NOT open even though a broader prefix is allowed.
const DENY: Partial<Record<Tier, string[]>> = {
  // The sound lead sees the queue, not the full-console reporting/automation tools.
  'sound-mgmt': ['/admin/workspace', '/admin/routine', '/admin/upload-review'],
}

function underAny(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => path === p || path.startsWith(p + '/'))
}

/** May this tier open `path`? Drives both nav visibility and page access. */
export function tierAllows(tier: Tier, path: string): boolean {
  if (tier === 'admin') return true
  if (path === '/') return true
  if (underAny(path, ALWAYS)) return true
  const deny = DENY[tier]
  if (deny && underAny(path, deny)) return false
  return underAny(path, ALLOW[tier as Exclude<Tier, 'admin'>])
}
