import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { google } from 'googleapis'
import {
  getProducerDashboardSheetId,
  getBookingsTabName,
  isUsingSandboxSheet,
  maskSheetId,
  SANDBOX_PRODUCER_DASHBOARD_SHEET_ID,
} from '@/lib/google-config'
import { getCalendarImpersonateSubject, getCalendarAuth } from '@/lib/google-calendar'
import { getSheetsWriteAuth, getSheetsReadAuth } from '@/lib/google-sheets'
import { fetchAllEpisodeRows, isPublishedStatus } from '@/lib/dashboard-episodes'

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
  const session = await requireConsole()
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
  // v1.32.1 — checks now use the SAME auth helpers production code uses.
  // Previously this endpoint built its own JWT inline with .readonly scopes
  // + impersonate everywhere, which mismatched prod (calendar uses full
  // scope + impersonate; sheets uses full scope + NO impersonate) and
  // produced false `unauthorized_client` failures even when real flows
  // worked. Codex review 2026-05-24.
  //
  // Three checks, one per distinct auth model:
  //   1. Calendar       — full scope, DWD impersonate (matches google-calendar.ts)
  //   2. Sheets WRITE   — full scope, service-account direct (matches google-sheets.ts)
  //   3. Sheets READ    — readonly scope, service-account direct (matches projects/people/dashboard-episodes)
  const [db, calendarCheck, sheetsWrite, sheetsRead, episodeTabs] = await Promise.all([
    timed(async () => {
      const n = await prisma.booking.count()
      return `${n} bookings`
    }),
    timed(async () => {
      if (!getCalendarImpersonateSubject()) {
        throw new Error('no impersonate subject configured (DWD off)')
      }
      const cal = google.calendar({ version: 'v3', auth: getCalendarAuth() })
      const res = await cal.calendars.get({
        calendarId: process.env.GOOGLE_CALENDAR_ID ||
          '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com',
      })
      return res.data.summary || '(no summary)'
    }),
    timed(async () => {
      // Write-auth metadata read. Verifies the auth model production
      // uses to APPEND rows to the Bookings tab.
      const sheets = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
      const res = await sheets.spreadsheets.get({
        spreadsheetId: getProducerDashboardSheetId(),
        fields: 'properties.title,sheets.properties.title',
      })
      const title = res.data.properties?.title || '(no title)'
      const tabs = (res.data.sheets || []).map(s => s.properties?.title).filter(Boolean)
      return `"${title}" · ${tabs.length} tabs (${tabs.slice(0, 5).join(', ')}${tabs.length > 5 ? '…' : ''})`
    }),
    timed(async () => {
      // Read-auth metadata read. Verifies the auth model used by the
      // booking-form dropdowns (projects/people/dashboard-episodes).
      const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
      const res = await sheets.spreadsheets.get({
        spreadsheetId: getProducerDashboardSheetId(),
        fields: 'properties.title',
      })
      return res.data.properties?.title || '(no title)'
    }),
    timed(async () => {
      // v1.43.0 — episode visibility canary. Runs the EXACT read path the
      // booking form uses (PD tabs + legacy _EPs). Catches the June 2026
      // failure mode — Dashboard restructures that silently empty the
      // bookable-episode list — before users hit "ไม่มี episode ที่ถ่ายได้".
      // Zero episode rows across every tab = integration break, not data.
      const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
      const episodes = await fetchAllEpisodeRows(sheets, getProducerDashboardSheetId())
      if (episodes.length === 0) {
        throw new Error('0 episode rows parsed from PD/_EPs tabs — column layout or tab naming probably changed')
      }
      const bookable = episodes.filter(e => !isPublishedStatus(e.status)).length
      return `${episodes.length} episodes (${bookable} bookable, ${episodes.length - bookable} published)`
    }),
  ])

  const allOk = db.ok && calendarCheck.ok && sheetsWrite.ok && sheetsRead.ok && episodeTabs.ok
  return NextResponse.json(
    {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      config,
      checks: {
        db,
        // Renamed to expose the auth model in the key so the UI / docs
        // / log lines never confuse them again.
        googleCalendarDwd: calendarCheck,
        producerDashboardSheetWrite: sheetsWrite,
        producerDashboardSheetRead: sheetsRead,
        episodeTabsRead: episodeTabs,
      },
    },
    { status: allOk ? 200 : 503 },
  )
}
