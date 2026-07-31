/**
 * v1.159 — staging environment guardrails (item 3 of the robustness plan).
 *
 * A staging stack runs the SAME image against the SAME Google APIs — the only
 * thing separating it from production is configuration. That is not enough on
 * its own, because this codebase carries HARDCODED production fallbacks (the
 * Production Team drive id in video-merge/prep/rename/backfill, the photo
 * drive id in google-drive.ts): a staging container missing one env var would
 * silently start sweeping the REAL crew drives.
 *
 * So the rule is FAIL-CLOSED, enforced at the auth choke points every Google
 * call passes through (getDriveReadAuth / getDriveWriteAuth /
 * getCalendarAuth): when APP_ENV=staging, every Drive root must be EXPLICITLY
 * configured and must NOT be a known production drive id — otherwise the call
 * throws before any API client exists. Email is sandboxed to the admin
 * address; the calendar is off unless explicitly opted in.
 *
 * Production behavior is untouched: every guard here is a no-op unless
 * APP_ENV === 'staging'.
 */

export function isStaging(): boolean {
  return (process.env.APP_ENV || '').trim().toLowerCase() === 'staging'
}

/** The real drives. A staging stack must never point at ANY of these. */
export const PROD_DRIVE_IDS: ReadonlyArray<string> = [
  '0AH7f4FZNrHsOUk9PVA', // VIDEO 2026 footage root (DRIVE_FOOTAGE_ROOT)
  '0AGendsFHFQYKUk9PVA', // Production Team landing / NAS drop zone
  '0ALBpF3fzYT-SUk9PVA', // Photographer shared drive
]

/**
 * Pure check (unit-testable): given the configured roots, return the reason
 * staging must refuse to run, or null when isolation holds. Missing = refuse
 * (fail-closed against the hardcoded prod fallbacks), prod id = refuse.
 */
export function stagingDriveViolation(roots: Record<string, string | undefined>): string | null {
  for (const [key, raw] of Object.entries(roots)) {
    const v = raw?.trim()
    if (!v) {
      return `${key} is not set — staging requires EVERY drive root to be explicitly configured ` +
        `(fail-closed: the code has hardcoded production fallbacks that would engage otherwise)`
    }
    if (PROD_DRIVE_IDS.includes(v)) {
      return `${key} points at a PRODUCTION drive (${v}) — staging must use its own drives`
    }
  }
  return null
}

/**
 * The guard installed in the Drive auth factories. No-op outside staging.
 * Throws with an operator-readable message when staging is misconfigured, so
 * every worker/route fails loudly instead of touching the real drives.
 */
/**
 * Optional drive-adjacent features whose target ids are env-only (the real
 * docs folder / backup folder ids are NOT in the repo, so they cannot be
 * blocklisted like the drive roots). Fail-closed rule on staging: they must be
 * UNSET — docs uploads may be re-enabled deliberately with STAGING_ALLOW_DOCS=1
 * plus a staging folder id; backup has no staging use at all.
 * (v1.159.1 review fix: documents/purchase uploads write to DRIVE_DOCS_ROOT
 * through the guarded write auth, so the root itself must be policed.)
 */
export function stagingOptionalDriveViolation(env: Record<string, string | undefined>): string | null {
  const docs = env.DRIVE_DOCS_ROOT?.trim()
  if (docs && env.STAGING_ALLOW_DOCS?.trim() !== '1') {
    return 'DRIVE_DOCS_ROOT is set — on staging leave it unset, or set STAGING_ALLOW_DOCS=1 with a STAGING folder id'
  }
  if (env.BACKUP_DRIVE_FOLDER_ID?.trim()) {
    return 'BACKUP_DRIVE_FOLDER_ID is set — staging must not upload backups anywhere; unset it'
  }
  return null
}

export function assertStagingDriveIsolation(): void {
  if (!isStaging()) return
  const violation = stagingDriveViolation({
    DRIVE_FOOTAGE_ROOT: process.env.DRIVE_FOOTAGE_ROOT,
    DRIVE_PRODUCTION_TEAM_ROOT: process.env.DRIVE_PRODUCTION_TEAM_ROOT,
    DRIVE_PHOTO_ROOT: process.env.DRIVE_PHOTO_ROOT,
  }) || stagingOptionalDriveViolation(process.env as Record<string, string | undefined>)
  if (violation) throw new Error(`[staging-guard] ${violation}`)
}

/**
 * v1.159.1 — destination checks for targets whose PRODUCTION ids ARE in the
 * repo (dashboard sheet, shared calendar): flipping the STAGING_ALLOW_* flag
 * without repointing the id must still refuse. Pure two-arg form so call sites
 * pass their own constant and tests need no google imports.
 */
export function stagingBlocksTarget(activeId: string | null | undefined, prodId: string): boolean {
  return isStaging() && !!activeId && activeId.trim() === prodId
}

/**
 * Calendar on staging is opt-in: it writes to whatever GOOGLE_CALENDAR_ID is
 * configured and EMAILS INVITES to real attendees, so it stays dead until the
 * operator both points it at a test calendar and sets STAGING_ALLOW_CALENDAR=1.
 */
export function stagingBlocksCalendar(): boolean {
  return isStaging() && process.env.STAGING_ALLOW_CALENDAR?.trim() !== '1'
}

/**
 * Sheets on staging is opt-in: dead until STAGING_ALLOW_SHEETS=1 with a COPY
 * of the dashboard sheet. The flag alone is not enough — the production sheet
 * id IS in the repo (google-config.ts), so assertStagingSheetsAllowed() in
 * google-sheets.ts ALSO refuses when the active id is the production one
 * (v1.159.1 review fix; the earlier claim that it couldn't be blocklisted was
 * wrong).
 */
export function stagingBlocksSheets(): boolean {
  return isStaging() && process.env.STAGING_ALLOW_SHEETS?.trim() !== '1'
}
