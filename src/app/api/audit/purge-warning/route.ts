/**
 * GET /api/audit/purge-warning
 *
 * Admin-only. Returns whether the dashboard should show the "audit logs will
 * be purged soon" banner, plus the numbers the banner needs to render.
 * See src/lib/audit-retention.ts for the policy constants.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { getPurgeWarning } from '@/lib/audit-retention'
import { tryAutoEmailPurgeWarning } from '@/lib/audit-auto-email'

export async function GET(_request: NextRequest) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const warning = await getPurgeWarning()

    // Fire-and-forget auto-email when an admin loads the dashboard during
    // the warning window. Throttled to once per 24 h inside the helper, so
    // many dashboard loads won't spam recipients. Awaiting would block the
    // banner from rendering on SMTP latency — not worth it.
    if (warning.shouldWarn) {
      tryAutoEmailPurgeWarning().catch(err =>
        console.error('[purge-warning] auto-email error:', err?.message || err),
      )
    }

    return NextResponse.json(warning)
  } catch (error) {
    console.error('GET /api/audit/purge-warning error:', error)
    return NextResponse.json({ error: 'Failed to load warning' }, { status: 500 })
  }
}
