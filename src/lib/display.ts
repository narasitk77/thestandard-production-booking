/**
 * Shared display helpers for booking rows.
 *
 * bookingShowName — the show the crew is shooting, used everywhere a
 * booking is labeled (in-app calendar, overview, my-bookings, producer
 * and admin lists, and — via the same rule in buildEventTitle — the
 * Google Calendar event). Content Agency bookings lead with the
 * project name (e.g. "KEY MESSAGES x DMHT"); outlet bookings with the
 * program name. Keep this rule in ONE place so every platform agrees
 * (ops feedback, June 2026: "ชื่อรายการแสดงบน calendar ทุก platform").
 */
export function bookingShowName(b: {
  projectName?: string | null
  program: { name: string }
}): string {
  return b.projectName?.trim() || b.program.name
}
