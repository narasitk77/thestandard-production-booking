/**
 * Client side of `GET /api/bookings` — one place for the two rules every list
 * page kept re-implementing (and drifting on). maint 2026-11-08 (B5-ui).
 *
 * 1. **error is not emptiness** (bug-classes §2). `.then(r => r.json()).then(d =>
 *    setX(d.bookings || []))` turned a 401/500/502 into "No REQUESTED bookings." /
 *    "No upcoming bookings — create one". fetchBookingList THROWS instead, so a
 *    page has to render the failure.
 * 2. **no silent caps** (§4) + **a multi-day shoot occupies every day** (§9).
 *    The API returns `truncated`; the day helpers below are the span rule the
 *    calendar and ProducerDashboard already had, now shared with home,
 *    my-bookings, the admin queue and the room schedule (which only tested
 *    shootDate, so day 2–3 of a 3-day shoot looked free).
 *
 * Dates are `YYYY-MM-DD` strings: shootDate/shootEndDate are `@db.Date` (UTC
 * midnight), so `.slice(0, 10)` is the calendar day, and strings compare
 * lexically. "Today" comes from todayBangkokStr (bangkok-day.ts).
 */

export interface BookingListResult<T> {
  bookings: T[]
  total: number
  /** rows exist that this response did not include */
  truncated: boolean
}

/** GET /api/bookings?<params>. Throws on non-OK, non-JSON, or a body without a list. */
export async function fetchBookingList<T = any>(
  params: Record<string, string> | URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<BookingListResult<T>> {
  const qs = new URLSearchParams(params as any).toString()
  const r = await fetchImpl(`/api/bookings?${qs}`, { credentials: 'include' })
  let d: any = null
  try { d = await r.json() } catch { /* 502 HTML page etc. — reported below */ }
  if (!r.ok || !d || !Array.isArray(d.bookings)) {
    throw new Error(d?.error ? `${d.error} (HTTP ${r.status})` : `โหลดรายการงานไม่สำเร็จ (HTTP ${r.status})`)
  }
  const total = typeof d.total === 'number' ? d.total : d.bookings.length
  const truncated = typeof d.truncated === 'boolean' ? d.truncated : d.bookings.length < total
  return { bookings: d.bookings, total, truncated }
}

export function addDaysStr(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

type Span = { shootDate: string; shootEndDate?: string | null }

/** [start, end] day keys; a missing or before-start end = single day (bad data). */
export function bookingDays(b: Span): { start: string; end: string } {
  const start = (b.shootDate || '').slice(0, 10)
  const endRaw = (b.shootEndDate || '').slice(0, 10)
  return { start, end: endRaw && endRaw > start ? endRaw : start }
}

/** Does the booking occupy this day (any day of a multi-day shoot)? */
export function bookingCoversDay(b: Span, ymd: string): boolean {
  const { start, end } = bookingDays(b)
  return !!start && start <= ymd && ymd <= end
}

/** Does the booking touch the half-open day range [from, to)? */
export function bookingOverlapsRange(b: Span, from: string, to: string): boolean {
  const { start, end } = bookingDays(b)
  return !!start && start < to && end >= from
}

/** Every day key the booking occupies — capped at 31 so a typo'd year can't flood a calendar. */
export function bookingDayKeys(b: Span): string[] {
  const { start, end } = bookingDays(b)
  if (!start) return []
  const out: string[] = []
  for (let d = start; d <= end && out.length < 31; d = addDaysStr(d, 1)) out.push(d)
  return out
}

/** Monday (Mon–Sun week) of the week containing ymd. */
export function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay() // 0 = Sun
  return addDaysStr(ymd, -((dow + 6) % 7))
}

/**
 * Minutes [start, end) a booking holds on `ymd`, for the room schedule. A
 * multi-day booking is booked in the central room system as ONE continuous
 * window (room-booking.ts resolveShootWindow: day 1 call → last day wrap), so a
 * middle day is held all day, day 1 from call time, the last day until wrap.
 * `wrapMin` is the already-resolved wrap of the shoot (effectiveWrap).
 */
export function heldMinutesOnDay(b: Span, ymd: string, callMin: number, wrapMin: number): { start: number; end: number } | null {
  if (!bookingCoversDay(b, ymd)) return null
  const { start, end } = bookingDays(b)
  if (start === end) return { start: callMin, end: wrapMin }
  return { start: ymd === start ? callMin : 0, end: ymd === end ? wrapMin : 24 * 60 }
}
