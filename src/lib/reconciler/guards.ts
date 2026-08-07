/**
 * v1.167 — the invariants the reconciler must preserve verbatim (design §5).
 *
 * Every predicate here already exists somewhere in the seven workers this pass
 * replaces — several of them in FOUR copies that have quietly drifted apart.
 * Collecting them is not tidying: each one is a rule that was written after
 * something went wrong in production, and a phase that reimplements it slightly
 * differently reintroduces that incident.
 *
 * Pure functions only. No Prisma, no googleapis — so the rules can be tested
 * exhaustively without a Drive.
 */

// ── markers ──────────────────────────────────────────────────────────────────

/**
 * Is this file one of OUR `_SHOOT` marker stubs?
 *
 * THE COPIES DISAGREED, AND IT MATTERS. Four call sites use `/^_SHOOT.*\.txt$/i`
 * (shoot-marker-reconcile.ts:53, prep-folders.ts:32, shoot-marker.ts:135) and
 * three use `/^_SHOOT\b.*\.txt$/i` (folder-integrity.ts:55, landing-lifecycle.ts:37,
 * landing-dedup.ts:21). They differ on real names:
 *
 *     _SHOOTING-notes.txt   → \b: NOT a marker   ·   no-\b: a marker
 *     _SHOOTLIST.txt        → \b: NOT a marker   ·   no-\b: a marker
 *
 * The `\b` form is the SAFE one in both directions and is what we standardise on:
 *   - "is this folder empty?" — a crew file called `_SHOOTLIST.txt` must count as
 *     REAL content, or the landing-cleanup gate trashes a folder that still has
 *     someone's work in it.
 *   - "does a marker already exist?" — the loose form would see `_SHOOTING.txt`
 *     and skip creating the real marker, leaving the footage crawler blind.
 */
export const SHOOT_MARKER_RE = /^_SHOOT\b.*\.txt$/i

export function isShootMarkerFile(name: string): boolean {
  return SHOOT_MARKER_RE.test((name || '').trim())
}

/**
 * The Production ID a marker filename carries, RAW — deliberately not normalised.
 *
 * v1.146: four "collision pair" bookings legitimately keep their legacy `[TYPE]`
 * code. Normalising before comparing made the reconciler read their live markers
 * as stale and trash them.
 */
export function markerCodeFromFilename(name: string): string | null {
  const m = (name || '').trim().match(/^_SHOOT-(.+)\.txt$/i)
  return m ? m[1] : null
}

/**
 * Does a rendered marker line carry a Buddhist year? Line-anchored ON PURPOSE.
 *
 * v1.134: an unanchored match fired on any 4-digit 25xx anywhere in the file, so
 * the nightly pass rewrote the same marker every night forever. Pair this with
 * "do not rewrite while our own renderer still emits a Buddhist year", or the
 * loop simply moves one level up.
 */
export function markerDateHasBuddhistYear(content: string): boolean {
  return (content || '').split('\n').some(line => /^\s*(วันถ่าย|Shoot date)\s*:.*\b(25\d{2})\b/i.test(line))
}

// ── "is this folder empty?" ──────────────────────────────────────────────────

/**
 * Real content = anything that is not one of our own marker stubs.
 *
 * This is the predicate every trash gate hangs on (landing cleanup, empty-twin
 * consume, folder-integrity's probe). Treating an unrecognised file as REAL is
 * the fail-safe direction: the cost of being wrong is a folder that sticks
 * around, versus a folder full of someone's footage in the bin.
 */
export function isRealContentFile(name: string): boolean {
  return !isShootMarkerFile(name)
}

export function hasRealFiles(names: Array<string | { name: string }>): boolean {
  return (names || []).some(n => isRealContentFile(typeof n === 'string' ? n : n?.name || ''))
}

// ── landing lifecycle ────────────────────────────────────────────────────────

/**
 * May this landing drop folder be trashed?
 *
 * BOTH conditions, always (docs/landing-folder-policy.md):
 *   1. its last shoot day is in the PAST — not merely "not today". v1 used
 *      "non-today", which includes TOMORROW's folder, created at 19:00 the night
 *      before; a prune running after 19:00 deleted the drop zone the crew was
 *      about to use. Past-only makes the predicate safe at any hour, at any
 *      frequency.
 *   2. it holds no real files. A folder with footage is `keptRecent`, forever.
 */
export function landingMayBeTrashed(input: {
  lastShootDay: Date | null
  today: Date
  hasFiles: boolean
}): boolean {
  if (input.hasFiles) return false
  if (!input.lastShootDay) return false
  return startOfDay(input.lastShootDay).getTime() < startOfDay(input.today).getTime()
}

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setUTCHours(0, 0, 0, 0)
  return c
}

/** Ageing always uses the LAST shoot day — a multi-day shoot is not over on day one. */
export function lastShootDay(b: { shootDate: Date; shootEndDate?: Date | null }): Date {
  return b.shootEndDate ?? b.shootDate
}

/** Does this booking's span cover `day`? (v1.146 multi-day semantics.) */
export function spanCoversDay(b: { shootDate: Date; shootEndDate?: Date | null }, day: Date): boolean {
  const from = startOfDay(b.shootDate).getTime()
  const to = startOfDay(lastShootDay(b)).getTime()
  const d = startOfDay(day).getTime()
  return d >= from && d <= to
}

// ── Drive probe: unknown is NOT "safe to proceed" ────────────────────────────

export type FootageProbe = 'in-tree' | 'out-of-tree' | 'unknown'

/**
 * Fail-CLOSED. A Drive read we could not complete (a 429 storm, an auth blip)
 * must never be read as "there is no footage here, safe to create/trash".
 * folder-integrity.ts:313-328 learned this the hard way.
 */
export function probeSaysSafeToCreate(probe: FootageProbe): boolean {
  return probe === 'out-of-tree'
}

export function probeBlocksDestructiveAction(probe: FootageProbe): boolean {
  return probe !== 'in-tree'
}

// ── rename gates ─────────────────────────────────────────────────────────────

/**
 * Ops intent outranks canonical tidiness. We only ever rename a folder whose
 * CURRENT name is one we generated ourselves; anything a human named is
 * reported, never corrected.
 */
export function isAppShapedFolderName(name: string, code: string): boolean {
  const n = (name || '').trim()
  if (!n || !code) return false
  // "<Show> · <Job> (<CODE>)" or the pre-v1.110 "<CODE> · <Job>".
  return n.includes(`(${code})`) || n.startsWith(`${code} · `) || n === code
}

/** The EP-folder equivalent — one predicate for one safety property. */
export function isAppShapedEpName(name: string, episodeId: string): boolean {
  const n = (name || '').trim()
  if (!n || !episodeId) return false
  return n === episodeId || n.startsWith(`${episodeId} · `)
}

// ── merge safety ─────────────────────────────────────────────────────────────

/**
 * Two files with the same name AND size are a duplicate: leave it in landing,
 * do not overwrite, do not trash. A human decides. (video-merge.ts:71-76)
 */
export function isDuplicateFile(a: { name: string; size?: number | string | null }, b: { name: string; size?: number | string | null }): boolean {
  if ((a?.name || '') !== (b?.name || '')) return false
  return String(a?.size ?? '') === String(b?.size ?? '')
}

/**
 * Twin matching uses the IMMUTABLE lead segment (the EP id before ' · '), never
 * a fuzzy name match. POP-PIV-260722-01 split one shoot across two EP folders
 * because a display name had been edited.
 */
export function immutableLead(name: string): string | null {
  const n = (name || '').trim()
  if (!n.includes(' · ')) return null
  const lead = n.split(' · ')[0].trim()
  return lead || null
}

export function twinsMatch(a: string, b: string): boolean {
  const la = immutableLead(a), lb = immutableLead(b)
  return !!la && !!lb && la === lb
}
