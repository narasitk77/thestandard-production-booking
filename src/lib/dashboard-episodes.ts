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

export type ListEpisodesResult =
  | { ok: true; episodes: ProjectEpisode[] }
  | { ok: false; error: string }

// List a project's episodes from the "_EPs" master tab, EXCLUDING ones already
// Published (those can't be booked for a new shoot). Columns in _EPs:
//   B ProjectName · C Product Code · D EP. · E Status · … · N Episode ID
export async function listProjectEpisodes(projectId: string): Promise<ListEpisodesResult> {
  const pid = String(projectId || '').trim()
  if (!/^PP-\d{2}-\d{3}$/.test(pid)) return { ok: false, error: `bad projectId: ${pid}` }
  if (!hasCredentials()) return { ok: false, error: 'Google service account not configured' }

  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '_EPs!A2:N',
    })
    const rows: string[][] = res.data.values || []
    const prefix = `${pid}-`
    const episodes: ProjectEpisode[] = []
    for (const row of rows) {
      const episodeId = String(row[13] || '').trim() // col N
      if (!episodeId.startsWith(prefix)) continue
      const status = String(row[4] || '').trim()     // col E
      if (status.toLowerCase() === 'published') continue
      const typeMatch = episodeId.slice(prefix.length).match(/^([A-Za-z]+)/)
      episodes.push({
        episodeId,
        type: typeMatch ? typeMatch[1].toUpperCase() : '',
        status,
        ep: String(row[3] || '').trim(),            // col D
        productCode: String(row[2] || '').trim(),    // col C
        projectName: String(row[1] || '').trim(),    // col B
      })
    }
    return { ok: true, episodes }
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
