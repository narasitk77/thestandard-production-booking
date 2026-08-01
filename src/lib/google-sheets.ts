import { google } from 'googleapis'
import { stagingBlocksSheets, stagingBlocksTarget } from './app-env'
import { PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID } from './google-config'
import { getProducerDashboardSheetId, getBookingsTabName } from './google-config'
// Drive Box ID (col AI) — read the stored id-first box link off the booking's
// driveFolders json (v1.114). Pure helper: no Drive/API call happens here.
import { getDriveLink } from './drive-links'

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

// 35 columns. PD/DIR are nicknames (match the rest of the Dashboard); the
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
  // Delivery evidence + metadata (append-only, cols AE–AI): Delivered At/By
  // from the "ส่งงาน" button (v1.89), Cancel Reason from the request-cancel
  // flow, Episode Titles (names — col Q has only the IDs), and the id-first
  // Drive box folder id (driveFolders.box, v1.114) so PMDC's Airtable sync
  // can link footage without a name walk.
  'Delivered At', 'Delivered By', 'Cancel Reason', 'Episode Titles',
  'Drive Box ID',
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
  // Delivery evidence + metadata (cols AE–AI, appended right of Main Videographer).
  deliveredAt: 31,
  deliveredBy: 32,
  cancelReason: 33,
  episodeTitles: 34,
  driveBoxId: 35,
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
/**
 * v1.159.1 — the ONE gate every sheets client must pass on staging:
 *   1. sheets are dead until STAGING_ALLOW_SHEETS=1 (opt-in), AND
 *   2. even opted-in, the active dashboard id must NOT be the production sheet
 *      (its id IS in the repo — flipping the flag without repointing refuses).
 * No-op in production. Modules that build their own JWT (people/projects/
 * dashboard-episodes/monitor) must call this too — review finding v1.159.1.
 */
export function assertStagingSheetsAllowed(): void {
  if (stagingBlocksSheets()) throw new Error('[staging-guard] sheets are disabled on staging (set STAGING_ALLOW_SHEETS=1 with a COPY of the dashboard sheet)')
  if (stagingBlocksTarget(getProducerDashboardSheetId(), PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID)) {
    throw new Error('[staging-guard] PRODUCER_DASHBOARD_SHEET_ID still points at the PRODUCTION dashboard sheet — set it to a COPY')
  }
}

export function getSheetsWriteAuth() {
  assertStagingSheetsAllowed() // v1.159.1 — staging opt-in + destination check
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
  assertStagingSheetsAllowed() // v1.159.1
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
  // title/sequence optional so legacy callers that only carry ids still
  // compile — they just produce an empty Episode Titles cell (col AH).
  episodes: Array<{ episodeId: string; title?: string | null; sequence?: number | null }>
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
  // Delivery evidence + metadata (cols AE–AI). All optional: a fresh booking
  // has none of them, so create-time appends leave the cells blank; the
  // backfill route passes full DB rows and fills them in.
  deliveredAt?: Date | string | null
  deliveredBy?: string | null
  cancelReason?: string | null
  driveFolders?: unknown
}

/**
 * Episode Titles (col AH) — every episode's title joined with " | ", ordered
 * by sequence when present (backfill's `episodes: true` include has no
 * orderBy; the create path is already sequence-ordered). Shared with the
 * booking PATCH route so title edits patch the same cell shape.
 */
export function joinEpisodeTitles(
  episodes: Array<{ title?: string | null; sequence?: number | null }>,
): string {
  return [...episodes]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map(e => (e.title || '').trim())
    .filter(Boolean)
    .join(' | ')
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
      // Cols AE–AI — blank on a fresh booking (deliver/cancel/approve routes
      // patch them later); the backfill route passes full DB rows so old
      // bookings land with these filled.
      fmtDateTime(booking.deliveredAt), // Delivered At
      booking.deliveredBy || '', // Delivered By
      booking.cancelReason || '', // Cancel Reason
      joinEpisodeTitles(booking.episodes), // Episode Titles
      getDriveLink(booking.driveFolders, 'box') || '', // Drive Box ID
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
  /** Cols AE–AI (delivery evidence + metadata). Pre-formatted strings —
   *  callers format datetimes th-TH BKK like the approve route's approvedAt. */
  deliveredAt: string
  deliveredBy: string
  cancelReason: string
  episodeTitles: string
  driveBoxId: string
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
