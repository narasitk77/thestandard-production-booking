import { google } from 'googleapis'

/**
 * Bookings → Producer Dashboard sync
 * ----------------------------------
 * Every booking is written as one row in the "Bookings" tab of the Producer
 * Dashboard sheet — the same sheet that owns "All Projects" and "_Users".
 * The Project ID column links each booking back to its project, so the
 * Dashboard (and the daily Airtable sync) can group bookings per project.
 *
 * The tab is auto-created on first write. Column order is append-only:
 * updateBookingRow's colMap hardcodes indices, so new columns go to the right.
 */

const DEFAULT_DASHBOARD_SHEET_ID = '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'
const SHEET_TAB = process.env.BOOKINGS_TAB || 'Bookings'

function getSheetId(): string {
  return process.env.PRODUCER_DASHBOARD_SHEET_ID || DEFAULT_DASHBOARD_SHEET_ID
}

// 28 columns. PD/DIR are nicknames (match the rest of the Dashboard); the
// *Email columns keep the canonical id so Airtable can join on either.
// PD Phone is filled only for non-Content-Agency outlets (free-text producer).
const HEADERS = [
  'Booking ID', 'Project ID', 'Project Name', 'Outlet', 'Program',
  'Shoot Date', 'Shoot End Date', 'Call Time', 'Wrap Time', 'Shoot Type',
  'Location', 'PD', 'PD Email', 'PD Phone', 'DIR', 'DIR Email',
  'Episode IDs', 'Crew Required', 'Category', 'Creative/Host', 'Assigned Emails',
  'Status', 'Calendar Event ID', 'Notes', 'Created By', 'Created At',
  'Approved At', 'Updated At',
]

// 1-indexed column positions for partial updates.
const COL = {
  assignedEmails: 21,
  status: 22,
  calendarEventId: 23,
  approvedAt: 27,
  updatedAt: 28,
} as const

function getAuth() {
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
      booking.id,
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

export async function updateBookingRow(rowIndex: number, fields: Partial<{
  assignedEmails: string
  status: string
  calendarEventId: string
  approvedAt: string
}>) {
  if (!hasCredentials() || !rowIndex) return
  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })

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

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      })
    }
  } catch (e) {
    console.error('updateBookingRow error:', e)
  }
}
