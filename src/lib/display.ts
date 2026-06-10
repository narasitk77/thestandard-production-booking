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
