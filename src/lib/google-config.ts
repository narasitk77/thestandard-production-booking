/**
 * Centralized Google integration config.
 *
 * Before v1.30 these constants were duplicated across 4 lib files
 * (google-sheets, projects, people, dashboard-episodes), which made
 * sandbox ↔ production sheet swaps a 4-file grep instead of a one-line
 * env change. Single source of truth here; the helpers always read
 * process.env at call time so changes via Portainer's env editor take
 * effect on the next request without a process restart.
 *
 * Env vars consumed:
 *  - PRODUCER_DASHBOARD_SHEET_ID  — Sheet that owns "All Projects",
 *    "_Users", "_EPs", and (for CA only) the "Bookings" tab written
 *    back by the app.
 *  - BOOKINGS_TAB                 — Optional override for the tab name
 *    inside the Producer Dashboard sheet (default "Bookings").
 *  - GOOGLE_IMPERSONATE_SUBJECT   — DWD impersonate user (handled in
 *    google-calendar.ts, listed here for completeness).
 *  - GOOGLE_CALENDAR_ID           — Shared Calendar event target.
 */

/**
 * The team's real, in-use Producer Dashboard sheet — the ONE sheet that
 * owns "All Projects", "_Users", "_EPs", and the "Bookings" tab the app
 * writes back to. Confirmed by ปุ๊ก (PMDC owner) 2026-07-21: this is
 * PRODUCTION, and the PMDC Airtable sync reads its "Bookings" tab daily.
 * It is the default when PRODUCER_DASHBOARD_SHEET_ID env is unset.
 *
 * Set that env var ONLY to point at a *different* (throwaway / test)
 * sheet — doing so flips isUsingSandboxSheet() to true and re-arms the
 * backfill guard. See docs/runbook-sheet-swap.md.
 *
 * NOTE (v1.148.3): this constant was previously named
 * SANDBOX_PRODUCER_DASHBOARD_SHEET_ID with the same value, which
 * mislabeled the live production sheet as "sandbox" — so /api/health
 * always reported isSandbox:true and the v1.148.1 backfill guard 409'd
 * every `apply` against the real sheet (the reported "still on sandbox"
 * blocker). There is no separate sandbox sheet; the team uses this one.
 * Renamed + inverted the sandbox test below to fix it.
 */
export const PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID =
  '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'

/** The currently-active Producer Dashboard sheet id (env wins). */
export function getProducerDashboardSheetId(): string {
  const fromEnv = process.env.PRODUCER_DASHBOARD_SHEET_ID?.trim()
  return fromEnv || PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID
}

/**
 * True when the app is pointed at a NON-production sheet — i.e. the env
 * override is set to something other than the real Producer Dashboard.
 * Default (no override, or override == the production id) is false.
 * Surfaced in /api/health and used by the backfill guard so a stray
 * `apply` can't dump hundreds of live bookings into a throwaway sheet.
 */
export function isUsingSandboxSheet(): boolean {
  return getProducerDashboardSheetId() !== PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID
}

/** Bookings tab name inside the Producer Dashboard sheet. */
export function getBookingsTabName(): string {
  return process.env.BOOKINGS_TAB || 'Bookings'
}

/**
 * Mask a sheet id for safe display: keep the first 6 and last 4 chars,
 * obscure the middle. Lets admins eyeball "right sheet" without
 * leaking the full id into screenshots / browser history.
 *   '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'
 *   → '10TnR0…pSzL4'
 */
export function maskSheetId(id: string | null | undefined): string {
  if (!id) return '(unset)'
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}
