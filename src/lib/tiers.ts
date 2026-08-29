/**
 * v1.90 — UI tiers: collapse (role × position) into the 5 experience tiers the
 * ops team asked for, and decide which pages/menus each tier may open. One
 * source of truth used by BOTH the Nav (hide items) and the middleware (block +
 * redirect), so menu and access can never drift apart.
 *
 *   admin        ADMIN / SUPPORT / MANAGER          → everything
 *   coordinator  COORDINATOR                        → full booking queue
 *   producer     position contains "producer"       → My Bookings / Producer
 *   crew         everyone else (Videographer/Sound/  → Upload job task
 *                Switcher/Director/Editor/…)
 */
export type Tier = 'admin' | 'coordinator' | 'producer' | 'crew'

export function resolveTier(role?: string | null, position?: string | null): Tier {
  const pos = (position || '').toLowerCase()
  if (role === 'ADMIN' || role === 'SUPPORT' || role === 'MANAGER') return 'admin'
  // v1.210 — the 'sound-mgmt' tier (position "Senior Sound Engineer" → a
  // queue locked to sound jobs, no console tools) is GONE. It existed for
  // exactly one person, whose actual role is COORDINATOR; the tier silently
  // overrode that role to grant LESS than the /admin/permissions screen said
  // he had, which is why "why can't I see the other jobs" had no answer
  // anywhere in the UI. Sound staff who are not coordinators still land on
  // 'crew' via the fall-through below, unchanged.
  if (role === 'COORDINATOR') return 'coordinator'
  if (pos.includes('producer')) return 'producer' // Producer + Co-Producer
  return 'crew'
}

/** Landing page / redirect target when a tier hits a page it can't open. */
export function tierHome(tier: Tier): string {
  switch (tier) {
    case 'producer': return '/my-bookings'
    case 'crew': return '/upload'
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
// v1.148.2 — '/producer' joined ALWAYS: being a producer is a role-on-a-booking,
// not a job title, so the position-based tier can't know who needs it (9 real
// producers — assistants/creators/PMs — were locked out and couldn't send
// update/time-change requests). The page + its APIs already scope everything
// by the session's own producerEmail, so opening it with zero bookings just
// shows an empty list. Same lesson as /new and /dashboard above.
// v1.166 — '/review' (post-shoot peer review, opened from an emailed token
// link) and '/feedback' ("เรื่องที่ฉันแจ้งไว้") join ALWAYS for the same reason
// as '/ot' and '/producer': both authorize at the data layer — /review is
// token-only and never trusts the session, /feedback scopes every query to the
// session's own email server-side. Leaving them out bounced exactly the people
// the feature exists for (crew tier) straight to /admin.
// v1.211 — '/switcher' เข้า ALWAYS ด้วยเหตุผลเดียวกับ '/ot': สวิตเชอร์อยู่ tier
// 'crew' ซึ่งเปิดได้แค่ /upload ถ้าไม่ปล่อยตรงนี้ middleware จะเด้งคนที่ฟีเจอร์นี้
// สร้างมาเพื่อเขาออกไปทุกครั้ง · การตัดสินตัวจริงอยู่ที่ src/app/switcher/layout.tsx
// ซึ่งรู้จัก roster (แบบเดียวกับ /ot ที่ ot/layout.tsx เป็นคนตัดสิน)
const ALWAYS = ['/calendar', '/my-bookings', '/profile', '/manual', '/changelog', '/dashboard', '/bookings', '/booking', '/new', '/ot', '/producer', '/review', '/feedback', '/switcher']
// Extra path prefixes each non-admin tier may open.
const ALLOW: Record<Exclude<Tier, 'admin'>, string[]> = {
  coordinator: ['/admin', '/ot', '/upload', '/new', '/producer', '/dashboard'],
  producer: ['/producer', '/new'],
  crew: ['/upload'],
}
function underAny(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => path === p || path.startsWith(p + '/'))
}

/** May this tier open `path`? Drives both nav visibility and page access. */
export function tierAllows(tier: Tier, path: string): boolean {
  if (tier === 'admin') return true
  if (path === '/') return true
  if (underAny(path, ALWAYS)) return true
  return underAny(path, ALLOW[tier as Exclude<Tier, 'admin'>])
}
