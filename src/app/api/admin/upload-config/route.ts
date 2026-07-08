import { NextResponse } from 'next/server'
import { requireConsole } from '@/lib/session'
import { hasDriveCredentials } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/upload-config
 *
 * Admin-only diagnostic for the upload stack (Drive-only since the Wasabi
 * dual-write was removed). Returns:
 *   - Which env vars are present (NOT the values — only "set" / "missing")
 *   - Whether Drive credentials look configured (no live check — saves
 *     a DWD round-trip; the upload init endpoint surfaces real errors)
 *
 * Used to verify a fresh deploy without having to attempt a real upload.
 * Run in browser: https://probook.xtec9.xyz/api/admin/upload-config
 */
export async function GET() {
  if (!(await requireConsole())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const config = {
    drive: {
      hasCredentials: hasDriveCredentials(),
      impersonateSubject: process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim() ?? '(default)',
      footageRoot: process.env.DRIVE_FOOTAGE_ROOT?.trim() ?? null,
    },
    footage: {
      sheetId: process.env.FOOTAGE_LOG_SHEET_ID?.trim() ? 'set' : 'MISSING',
      sheetTab: process.env.FOOTAGE_LOG_TAB?.trim() ?? '(default Sheet1)',
      workerEnabled: process.env.FOOTAGE_WORKER_ENABLED ?? '0',
      workerIntervalMs: process.env.FOOTAGE_WORKER_INTERVAL_MS ?? '(default 600000)',
    },
  }

  return NextResponse.json({
    config,
    summary: {
      driveReady: config.drive.hasCredentials && !!config.drive.footageRoot,
      footageSheetReady: config.footage.sheetId === 'set',
    },
  })
}
