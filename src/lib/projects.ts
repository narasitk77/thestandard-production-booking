import { google } from 'googleapis'

/**
 * Project ID layer (per memo from ปุ๊ก, 2026-05-08)
 * --------------------------------------------------
 * Producer Dashboard owns Project IDs (PP-YY-NNN) on the "All Projects" tab.
 * Production Booking pulls the dropdown options from there so Producers can
 * tag every booking with the matching Project ID — eliminating typo-prone
 * free-text project names and giving Airtable / Drive / Mimir a stable
 * upstream foreign key.
 *
 * Sheet contract:
 *   tab     : "All Projects"
 *   col A   : Project ID            (PP-YY-NNN)
 *   col B   : Project Name
 *   col C   : Producer (nickname)   (optional, used for auto-fill)
 *   col D   : Status                (optional — used to filter active rows)
 *
 * The mapping is intentionally narrow so this can keep working even if the
 * sheet grows new columns to the right.
 */

const DEFAULT_DASHBOARD_SHEET_ID = '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'
const DEFAULT_TAB = 'All Projects'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export type ProjectOption = {
  projectId: string
  projectName: string
  producer?: string
  status?: string
}

let cache: { ts: number; rows: ProjectOption[] } | null = null

function getDashboardAuth() {
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

export async function listProjects(opts: { force?: boolean } = {}): Promise<ProjectOption[]> {
  if (!opts.force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.rows
  }

  const sheetId = process.env.PRODUCER_DASHBOARD_SHEET_ID || DEFAULT_DASHBOARD_SHEET_ID
  const tab = process.env.PRODUCER_DASHBOARD_TAB || DEFAULT_TAB

  try {
    const auth = getDashboardAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tab}!A2:D`, // skip header row
    })
    const values = res.data.values || []
    const rows: ProjectOption[] = []
    for (const r of values) {
      const projectId = (r[0] || '').toString().trim()
      const projectName = (r[1] || '').toString().trim()
      if (!projectId.match(/^PP-\d{2}-\d{3}$/)) continue // strict format gate
      rows.push({
        projectId,
        projectName,
        producer: r[2] ? r[2].toString().trim() : undefined,
        status: r[3] ? r[3].toString().trim() : undefined,
      })
    }
    cache = { ts: Date.now(), rows }
    return rows
  } catch (e) {
    console.error('listProjects error:', e)
    // Return stale cache if available, else empty list (form falls back to free-text)
    return cache?.rows || []
  }
}

export function invalidateProjectsCache() {
  cache = null
}

export async function findProject(projectId: string): Promise<ProjectOption | null> {
  if (!projectId) return null
  const rows = await listProjects()
  return rows.find(r => r.projectId === projectId) || null
}
