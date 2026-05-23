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
 * SANDBOX Producer Dashboard sheet id. Fallback when
 * PRODUCER_DASHBOARD_SHEET_ID env is unset. Production deploys MUST
 * override this via the stack env to point at the real Producer
 * Dashboard sheet — see docs/runbook-sheet-swap.md for the swap procedure.
 */
export const SANDBOX_PRODUCER_DASHBOARD_SHEET_ID =
  '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'

/** The currently-active Producer Dashboard sheet id (env wins). */
export function getProducerDashboardSheetId(): string {
  const fromEnv = process.env.PRODUCER_DASHBOARD_SHEET_ID?.trim()
  return fromEnv || SANDBOX_PRODUCER_DASHBOARD_SHEET_ID
}

/**
 * True when the app is using the SANDBOX sheet (i.e. env override is
 * missing or matches the sandbox id). Surfaced in /api/health so admins
 * can verify production is pointed at a real sheet before going live.
 */
export function isUsingSandboxSheet(): boolean {
  return getProducerDashboardSheetId() === SANDBOX_PRODUCER_DASHBOARD_SHEET_ID
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
