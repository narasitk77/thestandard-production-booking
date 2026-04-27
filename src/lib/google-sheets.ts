import { google } from 'googleapis'

const SHEET_ID = process.env.GOOGLE_SHEETS_ID!
const SHEET_TAB = 'Bookings'

const HEADERS = [
  'Booking ID', 'Episode IDs', 'Outlet', 'Program',
  'Shoot Date', 'Shoot Type', 'Location', 'Call Time', 'Wrap Time',
  'Category', 'Producer', 'Creative/Host', 'Crew Required',
  'Assigned Emails', 'Agency Ref', 'Notes', 'Status',
  'Calendar Event ID', 'Created At', 'Approved At',
]

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

export async function ensureHeaders() {
  if (!SHEET_ID) return
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:T1`,
    })
    if (!res.data.values || res.data.values[0]?.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
      })
    }
  } catch (e) {
    console.error('ensureHeaders error:', e)
  }
}

export async function appendBookingRow(booking: {
  id: string
  episodes: Array<{ episodeId: string }>
  outlet: { name: string }
  program: { name: string }
  shootDate: Date | string
  shootType: string
  locationName?: string | null
  callTime: string
  estimatedWrap?: string | null
  category: string
  producer: string
  creative: string[]
  crewRequired: string[]
  assignedEmails?: string[]
  agencyRef?: string | null
  notes?: string | null
  status: string
  calendarEventId?: string | null
  createdAt: Date | string
  approvedAt?: Date | string | null
}): Promise<number | null> {
  if (!SHEET_ID) return null
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    await ensureHeaders()

    const row = [
      booking.id,
      booking.episodes.map(e => e.episodeId).join(', '),
      booking.outlet.name,
      booking.program.name,
      new Date(booking.shootDate).toISOString().split('T')[0],
      booking.shootType,
      booking.locationName || '',
      booking.callTime,
      booking.estimatedWrap || '',
      booking.category,
      booking.producer,
      booking.creative.join(', '),
      booking.crewRequired.join(', '),
      (booking.assignedEmails || []).join(', '),
      booking.agencyRef || '',
      booking.notes || '',
      booking.status,
      booking.calendarEventId || '',
      new Date(booking.createdAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      booking.approvedAt ? new Date(booking.approvedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '',
    ]

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:T`,
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
  adminNotes: string
}>) {
  if (!SHEET_ID || !rowIndex) return
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    const colMap: Record<string, number> = {
      assignedEmails: 14,
      status: 17,
      calendarEventId: 18,
      approvedAt: 20,
    }

    for (const [key, value] of Object.entries(fields)) {
      const col = colMap[key]
      if (!col || value === undefined) continue
      const colLetter = String.fromCharCode(64 + col)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!${colLetter}${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      })
    }
  } catch (e) {
    console.error('updateBookingRow error:', e)
  }
}
