import { redirect } from 'next/navigation'

/**
 * Legacy per-outlet booking form (pre-v1.28 wizard).
 *
 * Kept as a redirect to /new because the old form's URL pattern
 * (/booking/AGN, /booking/NWS, etc.) may still be bookmarked. New
 * booking flow is the 5-step wizard at /new, which picks the outlet
 * inside step 1 instead of via URL segment.
 *
 * Replaces the 400-line client form that previously lived here.
 * Removed v1.31 — no internal href referenced it.
 */
export default function LegacyOutletBookingPage() {
  redirect('/new')
}
