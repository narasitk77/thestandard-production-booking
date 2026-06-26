/**
 * Footage log Google Sheet writer — adaptive to the user's column layout.
 *
 * Background
 * ----------
 * The user maintains a "footage log" sheet (`FOOTAGE_LOG_SHEET_ID`) that
 * pairs Drive footage with production cues. They own the column structure
 * and explicitly said: don't change it. So this module never writes to
 * row 1 and only fills cells under columns it recognizes — extra columns
 * the user added stay untouched, missing columns get silently skipped.
 *
 * The sync worker (v1.34.2) calls `appendFootageRows()` with a batch of
 * file-derived records. We probe the live header row, normalize each
 * header name to a canonical key (lowercase, strip non-alnum), and look
 * it up in `CANONICAL_KEYS`. Aliases let the user write either "File
 * Name", "Filename", or "ชื่อไฟล์" and have it land in the same logical
 * column.
 *
 * Auth: reuses `getSheetsWriteAuth()` from `google-sheets.ts` — same SA
 * model. Sheet must be shared as Editor to `GOOGLE_SERVICE_ACCOUNT_EMAIL`
 * (already done per user's confirmation).
 */

import { google } from 'googleapis'
import { getSheetsWriteAuth } from './google-sheets'

// Public input shape — superset of the canonical column keys. Extra keys
// are silently dropped. All fields optional except `filename` (used as
// the row's identity for logging / error messages).
export interface FootageInput {
  productionId?: string | null
  filename: string
  camera?: string | null
  uploader?: string | null
  timestamp?: Date | string | null
  driveLink?: string | null
  driveFileId?: string | null
  bookingStatus?: string | null  // 'matched' | 'parsed_no_booking' | 'unparsed' — informational
  // Booking-derived enrichment, written only if the sheet has the column
  outletName?: string | null
  programName?: string | null
  shootDate?: Date | string | null
  producer?: string | null
}

// Canonical key → array of header aliases. Comparison is post-normalize
// (lowercase + alphanumeric-only) so the entries here are written that way.
//
// Adding a new alias here is a one-line code change. If the user adds a
// column we don't recognize, it'll just be blank in our appends — harmless,
// and the `scripts/inspect-footage-sheet.ts` diagnostic flags it.
const CANONICAL_KEYS: Record<keyof FootageInput, string[]> = {
  productionId:   ['productionid', 'bookingid', 'bookingcode', 'productioncode', 'id'],
  filename:       ['filename', 'file', 'name', 'filenameth', 'ชื่อไฟล์'.toLowerCase()],
  camera:         ['camera', 'cam', 'source'],
  uploader:       ['uploader', 'uploadedby', 'by', 'user'],
  timestamp:      ['timestamp', 'date', 'uploadedat', 'createdat', 'time'],
  driveLink:      ['drivelink', 'link', 'url', 'drive', 'webviewlink'],
  driveFileId:    ['drivefileid', 'fileid'],
  bookingStatus:  ['status', 'matchstatus', 'parsestatus'],
  outletName:     ['outlet', 'outletname', 'channel'],
  programName:    ['program', 'programname', 'show'],
  shootDate:      ['shootdate', 'productiondate'],
  producer:       ['producer', 'pd'],
}

function normalize(header: string): string {
  return (header || '').toLowerCase().replace(/[^a-z0-9ก-๙]/g, '')
}

interface HeaderMap {
  fetchedAt: number
  sheetId: string
  tabName: string
  rawHeaders: string[]
  /** canonical key → 0-based column index (only keys we found) */
  byKey: Partial<Record<keyof FootageInput, number>>
  /** raw header names we couldn't classify — surfaced by inspect script */
  unknown: string[]
}

const HEADER_CACHE_TTL_MS = 5 * 60 * 1000
let _cache: HeaderMap | null = null

function getEnvSheetId(): string | null {
  return process.env.FOOTAGE_LOG_SHEET_ID?.trim() || null
}
function getEnvTabName(): string {
  return process.env.FOOTAGE_LOG_TAB?.trim() || 'Sheet1'
}

function hasCreds(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY))
}

/**
 * Read the header row of the configured footage sheet and build a
 * canonical-key → column-index map. Cached for 5 minutes so a busy
 * worker doesn't slam the Sheets API. Caller can pass `force: true`
 * to bypass the cache (used by the inspect script).
 *
 * Returns null when the sheet is unconfigured or credentials are
 * missing — callers must handle this (the worker logs once and idles).
 */
export async function probeSheet(opts: { force?: boolean } = {}): Promise<HeaderMap | null> {
  const sheetId = getEnvSheetId()
  if (!sheetId || !hasCreds()) return null

  const tabName = getEnvTabName()
  const now = Date.now()
  if (!opts.force && _cache && _cache.sheetId === sheetId && _cache.tabName === tabName
      && now - _cache.fetchedAt < HEADER_CACHE_TTL_MS) {
    return _cache
  }

  const sheets = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!1:1`,
  })
  const rawHeaders = (res.data.values?.[0] ?? []).map(v => String(v ?? ''))

  const byKey: HeaderMap['byKey'] = {}
  const unknown: string[] = []

  for (let i = 0; i < rawHeaders.length; i++) {
    const norm = normalize(rawHeaders[i])
    if (!norm) continue
    let matched = false
    for (const [canonical, aliases] of Object.entries(CANONICAL_KEYS) as Array<[keyof FootageInput, string[]]>) {
      if (aliases.some(a => normalize(a) === norm)) {
        if (byKey[canonical] == null) byKey[canonical] = i
        matched = true
        break
      }
    }
    if (!matched) unknown.push(rawHeaders[i])
  }

  _cache = {
    fetchedAt: now,
    sheetId,
    tabName,
    rawHeaders,
    byKey,
    unknown,
  }
  return _cache
}

function fmtCell(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Max rows per single Sheets API append. Sheets accepts up to ~10MB per
// request and ~50K cells; at ~30 cells per row this gives us comfortable
// headroom (1000 × 30 = 30K cells). Chunking matters for the FIRST sync
// after FOOTAGE_WORKER_ENABLED=1 flips — that tick may discover thousands
// of pre-existing files all at once.
const APPEND_CHUNK_SIZE = 1000

/**
 * Append one or more rows to the footage log sheet. Returns the number of
 * rows actually appended (always equal to `rows.length` on success, 0 on
 * non-fatal "sheet unconfigured" cases). Throws on Sheets API failure so
 * the worker can retry on the next tick.
 *
 * Sparse-row strategy: build an array of `rawHeaders.length` cells per
 * row, fill only the columns whose canonical key appears in our input.
 * Never touches row 1. Never widens the sheet beyond the user's existing
 * column count.
 *
 * Chunked: batches >APPEND_CHUNK_SIZE rows are split across multiple
 * append calls. Each chunk is its own API request, so a mid-batch
 * failure leaves earlier chunks committed (sheet stays ahead of the
 * `FootageLog.sheetRowWritten=true` patch — that's why the worker
 * always flips the ledger flag AFTER `appendFootageRows` returns).
 */
export async function appendFootageRows(rows: FootageInput[]): Promise<number> {
  if (rows.length === 0) return 0
  const map = await probeSheet()
  if (!map) return 0
  if (map.rawHeaders.length === 0) {
    throw new Error(`Footage sheet ${map.sheetId} tab "${map.tabName}" has no header row — the worker needs row 1 populated to know where to put each field.`)
  }

  const rowToCells = (row: FootageInput): string[] => {
    const cells = new Array<string>(map.rawHeaders.length).fill('')
    for (const [canonical, colIdx] of Object.entries(map.byKey) as Array<[keyof FootageInput, number]>) {
      const v = row[canonical]
      if (v !== undefined) cells[colIdx] = fmtCell(v)
    }
    return cells
  }

  const sheets = google.sheets({ version: 'v4', auth: getSheetsWriteAuth() })
  let written = 0
  for (let i = 0; i < rows.length; i += APPEND_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + APPEND_CHUNK_SIZE).map(rowToCells)
    await sheets.spreadsheets.values.append({
      spreadsheetId: map.sheetId,
      range: `${map.tabName}!A2`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: chunk },
    })
    written += chunk.length
  }
  return written
}
