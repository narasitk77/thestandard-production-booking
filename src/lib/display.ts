/**
 * Shared display helpers for booking rows.
 *
 * bookingShowName — the show the crew is shooting, used everywhere a
 * booking is labeled (in-app calendar, overview, my-bookings, producer
 * and admin lists, and the Google Calendar event title via
 * buildEventTitle). Keep this rule in ONE place so every platform
 * agrees (ops feedback, June 2026: "ชื่อรายการแสดงบน calendar ทุก
 * platform").
 *
 * Resolution order:
 *   1. projectName            — Content Agency books a project
 *                               (e.g. "KEY MESSAGES x DMHT")
 *   2. episodes' program name — outlet bookings carry the real show per
 *                               EPISODE (v1.37 per-EP program dropdown,
 *                               e.g. "Key Message"); the booking-level
 *                               program is just the Episode-Type bucket
 *                               ("Long-form · รายการ · …"). Distinct
 *                               names are joined for mixed bookings.
 *   3. program name           — legacy bookings with no per-EP program.
 */
import { EPISODE_TYPE_PROGRAMS, UNIVERSAL_SHOW_TYPES } from './data'

// v1.111 — the universal Episode-Type program names (L/S/A/T). A booking whose
// program is one of these has no real show in `program` — the real show lives in
// the episode title (e.g. calendar-migrated bookings).
const GENERIC_TYPE_NAMES = new Set([...EPISODE_TYPE_PROGRAMS, ...UNIVERSAL_SHOW_TYPES].map(p => p.name))

export function bookingShowName(b: {
  projectName?: string | null
  program: { name: string }
  episodes?: Array<{ program?: { name: string } | null }> | null
}): string {
  const projectName = b.projectName?.trim()
  if (projectName) return projectName

  const epPrograms: string[] = []
  for (const e of b.episodes || []) {
    const name = e.program?.name?.trim()
    if (name && name !== b.program.name && !epPrograms.includes(name)) epPrograms.push(name)
  }
  if (epPrograms.length > 0) {
    return epPrograms.length <= 2
      ? epPrograms.join(' / ')
      : `${epPrograms[0]} +${epPrograms.length - 1}`
  }

  return b.program.name
}

/**
 * v1.111 — DISPLAY-ONLY show name. Same as bookingShowName, except when the
 * resolved name is a generic universal Episode-Type ("Long-form · รายการ …") —
 * which means the real show sits in the episode title (calendar-migrated
 * bookings) — it prefers the episode title(s). Kept SEPARATE from bookingShowName
 * on purpose: Drive folder naming/resolution keys off bookingShowName, and
 * changing it would relocate existing boxes. Use this ONLY for UI/labels/emails.
 */
export function bookingDisplayName(b: {
  projectName?: string | null
  program: { name: string }
  episodes?: Array<{ program?: { name: string } | null; title?: string | null }> | null
}): string {
  const base = bookingShowName(b)
  if (!GENERIC_TYPE_NAMES.has(base.trim())) return base
  const titles: string[] = []
  for (const e of b.episodes || []) {
    const t = e.title?.trim()
    if (t && t !== '-' && !titles.includes(t)) titles.push(t)
  }
  if (titles.length === 0) return base
  return titles.length <= 2 ? titles.join(' / ') : `${titles[0]} +${titles.length - 1}`
}
