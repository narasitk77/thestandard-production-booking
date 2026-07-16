import { google } from 'googleapis'
import { getProducerDashboardSheetId, getBookingsTabName } from './google-config'

/**
 * Bookings → Producer Dashboard sync
 * ----------------------------------
 * Every booking (all outlets) is written as one row in the "Bookings" tab
 * of the Producer Dashboard sheet — the same sheet that owns "All Projects"
 * and "_Users". (AGN-only until v1.148.0; widened so PMDC's Airtable sync
 * gets the Production ID spine for outlet shoots too. Kill-switch:
 * BOOKINGS_EXPORT_AGN_ONLY=1.) The Project ID column links each booking back
 * to its project, so the Dashboard (and the daily Airtable sync) can group
 * bookings per project.
 *
 * The tab is auto-created on first write. Column order is append-only:
 * updateBookingRow's colMap hardcodes indices, so new columns go to the right.
 */

// Sheet id + tab now centralized in src/lib/google-config.ts so sandbox ↔
// production swaps are a one-line env change instead of a 4-file grep.
const getSheetId = getProducerDashboardSheetId
const SHEET_TAB = getBookingsTabName()

// 30 columns. PD/DIR are nicknames (match the rest of the Dashboard); the
// *Email columns keep the canonical id so Airtable can join on either.
// PD Phone is filled only for non-Content-Agency outlets (free-text producer).
const HEADERS = [
  // v1.34.0 — "Booking ID" → "Production ID" (the human-readable code, e.g.
  // AGN-260423-EVT-01). Column position unchanged; `ensureSheetTab` will
  // rewrite the live header row on the next boot.
  'Production ID', 'Project ID', 'Project Name', 'Outlet', 'Program',
  'Shoot Date', 'Shoot End Date', 'Call Time', 'Wrap Time', 'Shoot Type',
  'Location', 'PD', 'PD Email', 'PD Phone', 'DIR', 'DIR Email',
  'Episode IDs', 'Crew Required', 'Category', 'Creative/Host', 'Assigned Emails',
  'Status', 'Calendar Event ID', 'Notes', 'Created By', 'Created At',
  'Approved At', 'Updated At', 'Video Type', 'Main Videographer',
]

// 1-indexed column positions for partial updates.
const COL = {
  // v1.109 — productionId (col A) + episodeIds (col Q) are writable so the
  // ID-regeneration flow can rewrite a booking's Production ID in place. The
  // row is still LOCATED by the OLD code (col A) before col A is overwritten.
  productionId: 1,
  shootDate: 6,
  shootEndDate: 7,
  episodeIds: 17,
  assignedEmails: 21,
  status: 22,
  calendarEventId: 23,
  approvedAt: 27,
  updatedAt: 28,
  mainVideographer: 30,
} as const

/**
 * Canonical write-path auth used by the Producer Dashboard sheet sync.
 *
 * Exported so `/api/health` exercises the same model the booking-create
 * write path actually uses (v1.32.1 — Codex review fix).
 *
 * Scope: `https://www.googleapis.com/auth/spreadsheets` (full read+write).
 * Impersonate: NONE — the Producer Dashboard sheet is shared directly
 * with the service account (Editor), so DWD is not needed for writes.
 * Trying to impersonate causes `unauthorized_client` because the DWD
 * grant in Workspace is scoped to calendar only.
 */
export function getSheetsWriteAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
}
// Internal alias kept so existing callsites (appendBookingRow,
// updateBookingRow) don't need to change.
const getAuth = getSheetsWriteAuth

/**
 * Canonical read-path auth used by `projects.ts`, `people.ts`, and
 * `dashboard-episodes.ts` to read "All Projects" / "_Users" / "_EPs"
 * tabs. v1.32.1 exports it from one place so `/api/health` can
 * exercise the same model (separate from the write path above — they
 * use different scopes).
 *
 * Scope: `spreadsheets.readonly`.
 * Impersonate: NONE (same as the write path).
 *
 * NOTE: the existing read-side callers still have their own local
 * copies of this auth setup — refactoring them to use this helper is
 * a desirable cleanup but out of scope for v1.32.1. /api/health uses
 * this directly to verify the read auth model.
 */
export function getSheetsReadAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
}

function hasCredentials(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
}

function colLetter(n: number): string {
  // supports n > 26 just in case
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

const lastCol = colLetter(HEADERS.length)

// Create the "Bookings" tab if it doesn't exist yet, then make sure row 1
// holds the header. Safe to call before every append.
async function ensureSheetTab(sheets: any, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const exists = (meta.data.sheets || []).some(
    (s: any) => s.properties?.title === SHEET_TAB
  )
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] },
    })
  }
  // Always (re)write row 1 so header/column changes propagate to the tab.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  })
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toISOString().split('T')[0]
}

function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
}

export type BookingRow = {
  id: string
  bookingCode?: string | null
  projectId?: string | null
  projectName?: string | null
  outlet: { name: string }
  program: { name: string }
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  locationName?: string | null
  producer: string
  producerEmail?: string | null
  producerPhone?: string | null
  director?: string | null
  directorEmail?: string | null
  episodes: Array<{ episodeId: string }>
  crewRequired: string[]
  category: string
  videoType?: string | null
  mainVideographerEmail?: string | null
  creative: string[]
  assignedEmails?: string[]
  status: string
  calendarEventId?: string | null
  notes?: string | null
  createdByEmail?: string | null
  createdAt: Date | string
}

export async function appendBookingRow(booking: BookingRow): Promise<number | null> {
  if (!hasCredentials()) return null
  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })
    await ensureSheetTab(sheets, spreadsheetId)

    const now = fmtDateTime(new Date())
    const row = [
      // "Production ID" column (renamed from "Booking ID" in v1.34.0) — the
      // human-readable code shown in the app (e.g. AGN-260522-EVT-01), NOT
      // the internal CUID. Falls back to CUID if a legacy row has no code.
      booking.bookingCode || booking.id,
      booking.projectId || '',
      booking.projectName || '',
      booking.outlet.name,
      booking.program.name,
      fmtDate(booking.shootDate),
      fmtDate(booking.shootEndDate),
      booking.callTime,
      booking.estimatedWrap || '',
      booking.shootType,
      booking.locationName || '',
      booking.producer,
      booking.producerEmail || '',
      booking.producerPhone || '',
      booking.director || '',
      booking.directorEmail || '',
      booking.episodes.map(e => e.episodeId).join(', '),
      booking.crewRequired.join(', '),
      booking.category,
      booking.creative.join(', '),
      (booking.assignedEmails || []).join(', '),
      booking.status,
      booking.calendarEventId || '',
      booking.notes || '',
      booking.createdByEmail || '',
      fmtDateTime(booking.createdAt),
      '', // Approved At — filled in later by the approve route
      now,
      booking.videoType || '', // Video Type — appended right of Updated At
      booking.mainVideographerEmail || '', // Main Videographer — set later at assign-time
    ]

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_TAB}!A:${lastCol}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
    const updatedRange = appendRes.data.updates?.updatedRange || ''
    const match = updatedRange.match(/(\d+)$/)
    return match ? parseInt(match[1]) : null
  } catch (e) {
    console.error('appendBookingRow error:', e)
    return null
  }
}

/**
 * Outcome of a sheet row patch. v1.109 — updateBookingRow used to return void and
 * swallow every failure, so callers couldn't tell a real write from a no-op. The
 * ID-regeneration flow needs the truth (to decide whether it may commit the DB),
 * so it now returns a status. Legacy callers that ignore the return are unaffected.
 */
export type SheetUpdateResult = 'updated' | 'not-found' | 'skipped' | 'error'

export async function updateBookingRow(bookingCode: string, fields: Partial<{
  /** v1.109 — rewrite col A (Production ID). Row is found by the OLD code passed
   *  as `bookingCode`, then col A is overwritten with this new value. */
  productionId: string
  /** v1.109 — rewrite col Q (Episode IDs), comma-joined. */
  episodeIds: string
  /** v1.109 — rewrite col F/G (Shoot Date / Shoot End Date), "YYYY-MM-DD". */
  shootDate: string
  shootEndDate: string
  assignedEmails: string
  status: string
  calendarEventId: string
  approvedAt: string
  mainVideographer: string
}>): Promise<SheetUpdateResult> {
  if (!hasCredentials() || !bookingCode) return 'skipped'
  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })

    // Find the row by Production ID (col A) instead of trusting a stored row
    // index — robust to manual insert/delete/sort in the Bookings tab, which
    // would otherwise make us patch the wrong booking.
    const colA = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TAB}!A2:A`,
    })
    const idx = (colA.data.values || []).findIndex(
      r => String(r[0] || '').trim() === bookingCode.trim(),
    )
    if (idx < 0) {
      console.error(`updateBookingRow: Production ID "${bookingCode}" not found in "${SHEET_TAB}" — skipping`)
      return 'not-found'
    }
    const rowIndex = idx + 2 // data rows start at sheet row 2

    const updates: { range: string; values: string[][] }[] = []
    for (const [key, value] of Object.entries(fields)) {
      const col = (COL as Record<string, number>)[key]
      if (!col || value === undefined) continue
      updates.push({
        range: `${SHEET_TAB}!${colLetter(col)}${rowIndex}`,
        values: [[String(value)]],
      })
    }
    // always bump "Updated At"
    updates.push({
      range: `${SHEET_TAB}!${colLetter(COL.updatedAt)}${rowIndex}`,
      values: [[fmtDateTime(new Date())]],
    })

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    })
    return 'updated'
  } catch (e) {
    console.error('updateBookingRow error:', e)
    return 'error'
  }
}
