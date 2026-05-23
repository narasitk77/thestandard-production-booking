/**
 * Initial team roster (crew assignment list).
 *
 * v1.30 and earlier: this lived as a hardcoded `TEAM` constant inside
 * src/app/admin/[id]/page.tsx, which meant adding/removing a crew member
 * required a code change + redeploy.
 *
 * v1.31 moves the list to the `TeamMember` Prisma table. This file is now
 * the SEED — used by `prisma/seed.ts` on first startup to populate an
 * empty `team_members` table, and as a last-resort fallback by the assign
 * UI if the DB query fails for any reason.
 *
 * After the first seed, the DB is the source of truth — edit at
 * /admin/team (admin-only) instead of changing this file. New roles can
 * still be added here AND wired into the /admin/[id] section list in
 * the same commit.
 */

export type RosterRole =
  | 'producer'
  | 'video'
  | 'director'
  | 'sound'
  | 'photo'
  | 'switcher'
  | 'virtualProduction'

export type RosterMember = {
  name: string
  email: string
  role: RosterRole
}

/** Display label for each role — used by /admin/team and assign UI. */
export const ROLE_LABEL: Record<RosterRole, string> = {
  producer: 'Producer / Coordinator',
  video: 'Videographer',
  director: 'Video Director',
  sound: 'Sound Team',
  photo: 'Photographer',
  switcher: 'Switcher',
  virtualProduction: 'Virtual Production',
}

/** Ordered list of roles for stable section ordering in the UI. */
export const ROLE_ORDER: RosterRole[] = [
  'producer',
  'video',
  'director',
  'sound',
  'photo',
  'switcher',
  'virtualProduction',
]

export const INITIAL_TEAM_ROSTER: RosterMember[] = [
  // Producer / Coordinator
  { role: 'producer', name: 'Nat · Narasit (Production Admin)', email: 'narasit.k@thestandard.co' },
  { role: 'producer', name: 'Tui · Tossapol (Coordinator)',     email: 'tossapol.b@thestandard.co' },
  { role: 'producer', name: 'Aom · Aomtian (Producer)',         email: 'aomtian.t@thestandard.co' },
  { role: 'producer', name: 'Zang · Onticha (Producer)',        email: 'onticha.t@thestandard.co' },
  { role: 'producer', name: 'Nice · Natchaya (Producer)',       email: 'natchaya.k@thestandard.co' },

  // Videographer
  { role: 'video', name: 'Bird · Nuttapong',     email: 'nuttapong.k@thestandard.co' },
  { role: 'video', name: 'Arm · Sakdipat',       email: 'sakdipat.p@thestandard.co' },
  { role: 'video', name: 'Noom · Thanakorn',     email: 'thanakorn.s@thestandard.co' },
  { role: 'video', name: 'Dome · Phuridej',      email: 'phuridej.p@thestandard.co' },
  { role: 'video', name: 'F · Panathorn',        email: 'panathorn.c@thestandard.co' },
  { role: 'video', name: 'P · Ratchaseth',       email: 'ratchaseth.c@thestandard.co' },
  { role: 'video', name: 'Kim · Chaiyaphat',     email: 'chaiyaphat.t@thestandard.co' },
  { role: 'video', name: 'Tew · Watcharapol',    email: 'watcharapol.c@thestandard.co' },

  // Video Director
  { role: 'director', name: 'Pook · Panu (Head Director)', email: 'panu.w@thestandard.co' },
  { role: 'director', name: 'Top · Tanapak',               email: 'tanapak.I@thestandard.co' },
  { role: 'director', name: 'PAT · Worased',               email: 'worased.p@thestandard.co' },
  { role: 'director', name: 'Paii · Panyapohn',            email: 'panyapohn.s@thestandard.co' },

  // Sound
  { role: 'sound', name: 'Art · Krittapon (Sr. Sound Eng.)', email: 'krittapon.j@thestandard.co' },
  { role: 'sound', name: 'Note · Daejarnat',                 email: 'daejarnat.d@thestandard.co' },
  { role: 'sound', name: 'Thee · Thaphat',                   email: 'thaphat.t@thestandard.co' },
  { role: 'sound', name: 'Peace · Nuthkitta',                email: 'nuthkitta.c@thestandard.co' },

  // Photographer
  { role: 'photo', name: 'Mod · Saluk (Photographer)', email: 'saluk.k@thestandard.co' },

  // Switcher
  { role: 'switcher', name: 'Dream · Kamonwan', email: 'kamonwan.l@thestandard.co' },
  { role: 'switcher', name: 'Ting · Jaruwan',   email: 'jaruwan.k@thestandard.co' },

  // Virtual Production
  { role: 'virtualProduction', name: 'Famp · Assawapol (Virtual Production)', email: 'assawapol.t@thestandard.co' },
]

/**
 * Group a flat roster into per-role lists, preserving ROLE_ORDER.
 * Used by both the assign UI (when grouping API results) and the
 * fallback path (when the API errors and we fall back to
 * INITIAL_TEAM_ROSTER).
 */
export function groupByRole<T extends { role: string }>(
  members: T[],
): Record<RosterRole, T[]> {
  const grouped: Record<RosterRole, T[]> = {
    producer: [], video: [], director: [], sound: [], photo: [], switcher: [], virtualProduction: [],
  }
  for (const m of members) {
    if (m.role in grouped) grouped[m.role as RosterRole].push(m)
  }
  return grouped
}
