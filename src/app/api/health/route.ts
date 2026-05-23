import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { google } from 'googleapis'
import {
  getProducerDashboardSheetId,
  getBookingsTabName,
  isUsingSandboxSheet,
  maskSheetId,
  SANDBOX_PRODUCER_DASHBOARD_SHEET_ID,
} from '@/lib/google-config'
import { getCalendarImpersonateSubject } from '@/lib/google-calendar'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health  — admin-only runtime config + live health snapshot.
 *
 * Use cases:
 *  1. After a sheet swap (sandbox → prod), confirm the running container
 *     is actually pointed at the new Producer Dashboard sheet.
 *  2. Diagnose why /admin/[id] Re-sync returns errors — this endpoint
 *     shows DWD impersonate state, Google Calendar reachability, DB
 *     connection, and which env vars came from real config vs.
 *     hardcoded fallbacks.
 *  3. Smoke-test after a deploy without poking around the UI.
 *
 * Response is admin-only and includes config IDs *masked* (first 6 + last
 * 4 chars). It never returns full secrets, private keys, or full sheet
 * IDs to the response body.
 */

type CheckResult =
  | { ok: true; latencyMs: number; detail?: string }
  | { ok: false; latencyMs: number; error: string }

async function timed(fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = Date.now()
  try {
    const detail = await fn()
    return { ok: true, latencyMs: Date.now() - t0, detail: detail || undefined }
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: e?.message || String(e) }
  }
}

export async function GET(_req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  // --- Config snapshot ---------------------------------------------------
  const sheetId = getProducerDashboardSheetId()
  const config = {
    nodeEnv: process.env.NODE_ENV || '(unset)',
    version: process.env.npm_package_version || '(unknown)',
    producerDashboardSheet: {
      id: maskSheetId(sheetId),
      source: process.env.PRODUCER_DASHBOARD_SHEET_ID?.trim()
        ? 'env'
        : 'hardcoded-fallback',
      isSandbox: isUsingSandboxSheet(),
      sandboxId: maskSheetId(SANDBOX_PRODUCER_DASHBOARD_SHEET_ID),
      bookingsTab: getBookingsTabName(),
    },
    calendar: {
      id: maskSheetId(process.env.GOOGLE_CALENDAR_ID || ''),
      impersonateSubject: getCalendarImpersonateSubject() || '(none)',
      impersonateSource: process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim()
        ? 'env'
        : 'hardcoded-fallback',
    },
    auth: {
      nextauthUrl: process.env.NEXTAUTH_URL || '(unset)',
      nextauthSecretSet: !!process.env.NEXTAUTH_SECRET?.trim(),
      calendarReconcileSecretSet: !!(
        process.env.CALENDAR_RECONCILE_SECRET ||
        process.env.NEXTAUTH_SECRET ||
        process.env.AUTH_SECRET
      ),
    },
    email: {
      provider: process.env.EMAIL_PROVIDER || '(default — Gmail OAuth + SMTP fallback)',
      smtpHost: process.env.SMTP_HOST || '(unset)',
      smtpUserSet: !!process.env.SMTP_USER?.trim(),
      smtpPassSet: !!process.env.SMTP_PASS?.trim(),
    },
  }

  // --- Live checks -------------------------------------------------------
  // Run in parallel. Each check is wrapped in `timed` so a slow upstream
  // doesn't hold the response forever (Node's default fetch has its own
  // timeout; we surface latency so admin can spot creeping slowness).
  const [db, calendar, sheet] = await Promise.all([
    timed(async () => {
      // Cheapest possible round-trip — just count one table.
      const n = await prisma.booking.count()
      return `${n} bookings`
    }),
    timed(async () => {
      const subject = getCalendarImpersonateSubject()
      if (!subject) throw new Error('no impersonate subject configured (DWD off)')
      const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        subject,
      })
      const cal = google.calendar({ version: 'v3', auth })
      const res = await cal.calendars.get({
        calendarId: process.env.GOOGLE_CALENDAR_ID ||
          '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com',
      })
      return res.data.summary || '(no summary)'
    }),
    timed(async () => {
      const subject = getCalendarImpersonateSubject()
      const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        subject,
      })
      const sheets = google.sheets({ version: 'v4', auth })
      const res = await sheets.spreadsheets.get({
        spreadsheetId: getProducerDashboardSheetId(),
        fields: 'properties.title,sheets.properties.title',
      })
      const title = res.data.properties?.title || '(no title)'
      const tabs = (res.data.sheets || [])
        .map(s => s.properties?.title)
        .filter(Boolean)
      return `"${title}" · ${tabs.length} tabs (${tabs.slice(0, 5).join(', ')}${tabs.length > 5 ? '…' : ''})`
    }),
  ])

  const allOk = db.ok && calendar.ok && sheet.ok
  return NextResponse.json(
    {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      config,
      checks: { db, googleCalendar: calendar, producerDashboardSheet: sheet },
    },
    { status: allOk ? 200 : 503 },
  )
}
