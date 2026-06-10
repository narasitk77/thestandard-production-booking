/**
 * Project Episodes — read-only lister from the Producer Dashboard sheet.
 * ---------------------------------------------------------------------
 * Content Agency bookings SELECT existing episodes of a project (the
 * episodes are created upstream by the Producer/Director in the Dashboard
 * UI, not by this app). This module reads the "_EPs" master tab so the
 * booking wizard can offer the project's still-bookable episodes.
 *
 * NOTE (v1.35.17): the in-app Episode ID *minting* path
 * (`generateProjectEpisodeIds` + its PD/Dir-tab writers) was removed — it
 * had no callers (booking is select-only) and writing episode rows via the
 * Sheets API bypasses the Dashboard's onEdit automations, so keeping it was
 * a foot-gun. Episode creation stays where it belongs: the Dashboard UI.
 */
import { google } from 'googleapis'
import { getProducerDashboardSheetId } from './google-config'

// Sheet id moved to src/lib/google-config.ts (v1.30 consolidation).

function getSheetId(): string {
  return getProducerDashboardSheetId()
}

function hasCredentials(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
}

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

export type ProjectEpisode = {
  episodeId: string   // PP-26-006-L01
  type: string        // L | S | A | T (parsed from the suffix)
  status: string      // Pre-production | Production | Post-production | Published
  ep: string          // the "EP." label (e.g. "-", "Short", "1. มารีญา")
  productCode: string
  projectName: string
}

/**
 * "_EPs" column resolution (v1.42.1)
 * ----------------------------------
 * The Dashboard team reshuffles the "_EPs" tab occasionally — Episode ID
 * moved col N→C and Status col E→H, which silently emptied the booking
 * episode list (every Pre-production episode "disappeared"). Resolve the
 * columns we need from the HEADER row by name instead of hardcoding
 * positions; fall back to the current known layout when a header is
 * missing or renamed.
 */
export type EpsColumns = {
  episodeId: number
  status: number
  ep: number
  productCode: number
  projectName: number
}

// Current layout: A ProjectID · B Episode Type · C Episode ID · D Project
// Name · E Director · F Product Code · G EP. · H Status · I… extras
const EPS_FALLBACK_COLUMNS: EpsColumns = {
  episodeId: 2,   // C
  status: 7,      // H
  ep: 6,          // G
  productCode: 5, // F
  projectName: 3, // D
}

const EPS_HEADERS: Record<keyof EpsColumns, RegExp> = {
  episodeId: /^episode\s*id$/i,
  status: /^status$/i,
  ep: /^ep\.?$/i,
  productCode: /^product\s*code$/i,
  projectName: /^project\s*name$/i,
}

export function resolveEpsColumns(header: unknown[] | undefined): EpsColumns {
  const cols = { ...EPS_FALLBACK_COLUMNS }
  if (!header) return cols
  for (const key of Object.keys(EPS_HEADERS) as (keyof EpsColumns)[]) {
    const idx = header.findIndex(h => EPS_HEADERS[key].test(String(h ?? '').trim()))
    if (idx >= 0) cols[key] = idx
  }
  return cols
}

export type ListEpisodesResult =
  | { ok: true; episodes: ProjectEpisode[] }
  | { ok: false; error: string }

// List a project's episodes from the "_EPs" master tab, EXCLUDING ones already
// Published (those can't be booked for a new shoot). Columns are resolved
// from the header row — see resolveEpsColumns above.
export async function listProjectEpisodes(projectId: string): Promise<ListEpisodesResult> {
  const pid = String(projectId || '').trim()
  if (!/^PP-\d{2}-\d{3}$/.test(pid)) return { ok: false, error: `bad projectId: ${pid}` }
  if (!hasCredentials()) return { ok: false, error: 'Google service account not configured' }

  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '_EPs!A1:R',
    })
    const values: string[][] = res.data.values || []
    const cols = resolveEpsColumns(values[0])
    const prefix = `${pid}-`
    const episodes: ProjectEpisode[] = []
    for (const row of values.slice(1)) {
      const episodeId = String(row[cols.episodeId] || '').trim()
      if (!episodeId.startsWith(prefix)) continue
      const status = String(row[cols.status] || '').trim()
      if (status.toLowerCase() === 'published') continue
      const typeMatch = episodeId.slice(prefix.length).match(/^([A-Za-z]+)/)
      episodes.push({
        episodeId,
        type: typeMatch ? typeMatch[1].toUpperCase() : '',
        status,
        ep: String(row[cols.ep] || '').trim(),
        productCode: String(row[cols.productCode] || '').trim(),
        projectName: String(row[cols.projectName] || '').trim(),
      })
    }
    return { ok: true, episodes }
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
