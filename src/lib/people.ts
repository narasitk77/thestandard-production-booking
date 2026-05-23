import { google } from 'googleapis'
import { getProducerDashboardSheetId } from './google-config'

/**
 * People layer — reads the Producer Dashboard "_Users" tab so the booking
 * form can offer Producer / Director dropdowns sourced from the single
 * shared roster (email · nickname · role), instead of a hardcoded list.
 *
 * Sheet contract — tab "_Users":
 *   col A : Email
 *   col B : Nickname
 *   col C : Role        (Producer / Director / Manager / …)
 */

// Sheet id moved to src/lib/google-config.ts (v1.30 consolidation).
const USERS_TAB = '_Users'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export type Person = {
  email: string
  nickname: string
  role: string
}

let cache: { ts: number; rows: Person[] } | null = null

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
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
}

export async function listPeople(opts: { force?: boolean } = {}): Promise<Person[]> {
  if (!opts.force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.rows
  }
  const sheetId = getProducerDashboardSheetId()
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${USERS_TAB}!A2:C`, // skip header
    })
    const values = res.data.values || []
    const rows: Person[] = []
    for (const r of values) {
      const email = (r[0] || '').toString().trim().toLowerCase()
      const nickname = (r[1] || '').toString().trim()
      const role = (r[2] || '').toString().trim()
      if (!email || !nickname) continue
      rows.push({ email, nickname, role })
    }
    cache = { ts: Date.now(), rows }
    return rows
  } catch (e) {
    console.error('listPeople error:', e)
    return cache?.rows || []
  }
}

export async function listByRole(role: string): Promise<Person[]> {
  const people = await listPeople()
  return people.filter(p => p.role.toLowerCase() === role.toLowerCase())
}

export function invalidatePeopleCache() {
  cache = null
}
