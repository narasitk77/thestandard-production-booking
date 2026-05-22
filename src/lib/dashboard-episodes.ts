/**
 * Project Episode IDs — generated IN-APP (replaces the Apps Script Web App).
 * ------------------------------------------------------------------------
 * For project-linked bookings we mint `PP-YY-NNN-{type}NN` IDs and write them
 * into the Producer Dashboard sheet ourselves, via the same Google service
 * account that already reads "All Projects" / "_Users" and writes the
 * "Bookings" tab. No Apps Script, no Web App URL/secret, no extra network hop.
 *
 * Numbering authority: the producer's "PD <producer>" tab (column C) is the
 * complete record of a project's episodes (old hand-typed + app-created), so
 * the next sequence = max(existing {projectId}-{type}NN in that tab) + 1. This
 * matches what the Apps Script's EP_SEQ counter held (it was seeded from the
 * same PD tabs). Requires the sheet's own onEdit auto-gen to be OFF so the app
 * is the single writer — fine now that booking is app-only.
 *
 * Mirrors the column layouts from apps-script/booking-episode-endpoint.gs:
 *   PD <producer>: A ProjectID · B Type · C EpisodeID · D ProjectName
 *                  E Director · F (Code, blank) · G EP.(title) · [H Status, later]
 *   Dir. <director>: A EpID · B Type · C ProjectName · D Producer · E EP. · F Status
 *                    (data rows start at row 3)
 *   All Projects: A ProjectID · B ProjectName · … · F Producer · G Director
 */
import { google } from 'googleapis'

const DEFAULT_DASHBOARD_SHEET_ID = '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'

export type GenerateResult =
  | { ok: true; episodeIds: string[] }
  | { ok: false; error: string }

const VALID_TYPES = ['L', 'S', 'A', 'T']

function getSheetId(): string {
  return process.env.PRODUCER_DASHBOARD_SHEET_ID || DEFAULT_DASHBOARD_SHEET_ID
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

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A1 sheet-name reference: wrap in single quotes, escaping embedded quotes.
function tabRef(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

type ProjectInfo = { projectName: string; producer: string; director: string }

async function lookupProject(
  sheets: any,
  spreadsheetId: string,
  projectId: string,
): Promise<ProjectInfo | null> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'All Projects!A2:G',
  })
  const rows: string[][] = res.data.values || []
  for (const row of rows) {
    if (String(row[0] || '').trim() === projectId) {
      return {
        projectName: String(row[1] || '').trim(),
        producer: String(row[5] || '').trim(),
        director: String(row[6] || '').trim(),
      }
    }
  }
  return null
}

// Highest existing sequence for {projectId}-{type} in the producer's PD tab
// (column C). Returns 0 when none exist yet.
async function maxSeqInPDTab(
  sheets: any,
  spreadsheetId: string,
  producer: string,
  projectId: string,
  type: string,
): Promise<number> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabRef(`PD ${producer}`)}!C2:C`,
  })
  const rows: string[][] = res.data.values || []
  const re = new RegExp(`^${escapeRegex(projectId)}-${type}(\\d+)$`)
  let max = 0
  for (const r of rows) {
    const m = String(r[0] || '').trim().match(re)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n > max) max = n
    }
  }
  return max
}

/**
 * Mint `count` Episode IDs for projectId+type, writing each into the producer's
 * PD tab and the director's Dir tab. Returns the IDs in order. Fails (ok:false)
 * if the project/producer/PD-tab can't be resolved or any sheet op errors — the
 * caller then refuses the booking rather than minting an out-of-sequence ID.
 */
export async function generateProjectEpisodeIds(input: {
  projectId: string
  type: string
  count: number
  titles?: string[]
}): Promise<GenerateResult> {
  const projectId = String(input.projectId || '').trim()
  const type = String(input.type || '').trim().toUpperCase()
  let count = parseInt(String(input.count), 10)
  if (!count || count < 1) count = 1
  const titles = Array.isArray(input.titles) ? input.titles : []

  if (!/^PP-\d{2}-\d{3}$/.test(projectId)) {
    return { ok: false, error: `bad projectId (expect PP-YY-NNN): ${projectId}` }
  }
  if (!VALID_TYPES.includes(type)) {
    return { ok: false, error: `bad type — expect L, S, A or T: ${type}` }
  }
  if (count > 20) {
    return { ok: false, error: 'count > 20 not allowed' }
  }
  if (!hasCredentials()) {
    return { ok: false, error: 'Google service account not configured' }
  }

  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })

    const info = await lookupProject(sheets, spreadsheetId, projectId)
    if (!info) return { ok: false, error: `project not found in "All Projects": ${projectId}` }
    if (!info.producer) return { ok: false, error: `no Producer set for ${projectId}` }

    const startSeq = (await maxSeqInPDTab(sheets, spreadsheetId, info.producer, projectId, type)) + 1

    const episodeIds: string[] = []
    for (let i = 0; i < count; i++) {
      const epId = `${projectId}-${type}${pad2(startSeq + i)}`
      const title = String(titles[i] || '').trim()

      // PD <producer>: A ProjectID · B Type · C EpisodeID · D Name · E Director
      //                F (Code, blank) · G EP.(title)   [H Status set later]
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabRef(`PD ${info.producer}`)}!A:G`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[projectId, type, epId, info.projectName, info.director, '', title]] },
      })

      // Dir. <director>: A EpID · B Type · C Name · D Producer · E EP. · F Status
      // Idempotent — skip if epId is already present (col A from row 3).
      if (info.director) {
        const dirTab = `Dir. ${info.director}`
        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${tabRef(dirTab)}!A3:A`,
        }).then((r: any) => (r.data.values || []).some((row: string[]) => String(row[0] || '').trim() === epId))
          .catch(() => false) // missing Dir tab is non-fatal — PD row is the record
        if (!existing) {
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${tabRef(dirTab)}!A:F`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [[epId, type, info.projectName, info.producer, title, '']] },
          }).catch(() => {}) // Dir mirror is best-effort; PD tab is authoritative
        }
      }

      episodeIds.push(epId)
    }

    return { ok: true, episodeIds }
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
