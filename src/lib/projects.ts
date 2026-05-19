import { google } from 'googleapis'

/**
 * Project ID layer — Producer Dashboard integration
 * --------------------------------------------------
 * The Producer Dashboard sheet owns Project IDs (PP-YY-NNN) on the
 * "All Projects" tab and Episode IDs (PP-YY-NNN-{L|S|A|T}NN) on "_EPs".
 * Production Booking pulls the project dropdown from "All Projects" so every
 * booking is tagged with the matching Project ID.
 *
 * "All Projects" columns (1-indexed):
 *   A Project ID   B Project Name   C Client       D Brief     E Brief Date
 *   F Producer     G Director       H Video Type   I Progress  J Note
 *
 * "_EPs" columns used here:
 *   E  Status      (idx 4)  — Pre-production | Production | Post-production | Published
 *   N  Episode ID  (idx 13) — PP-YY-NNN-{type}NN
 *
 * A project drops off the booking dropdown once EVERY one of its episodes is
 * "Published" (work finished). Projects with no episodes yet stay bookable.
 */

const DEFAULT_DASHBOARD_SHEET_ID = '10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4'
const DEFAULT_PROJECTS_TAB = 'All Projects'
const DEFAULT_EPS_TAB = '_EPs'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

const PROJECT_ID_RE = /^PP-\d{2}-\d{3}$/
// Episode ID = <projectId>-<type letter><sequence>, e.g. PP-26-008-L04
const EPISODE_ID_RE = /^(PP-\d{2}-\d{3})-[A-Z]\d{2,}$/

export type ProjectOption = {
  projectId: string
  projectName: string
  client?: string
  producer?: string
  director?: string
  videoType?: string
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

/**
 * Read "_EPs" and return the set of Project IDs whose episodes are ALL
 * "Published" — finished projects to hide from the booking dropdown.
 * A project with no episodes is never in this set (still bookable).
 */
async function fetchFullyPublishedProjectIds(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
  epsTab: string,
): Promise<Set<string>> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${epsTab}!A2:N`,
  })
  const values = res.data.values || []
  const tally = new Map<string, { total: number; published: number }>()
  for (const r of values) {
    const episodeId = (r[13] || '').toString().trim()
    const m = episodeId.match(EPISODE_ID_RE)
    if (!m) continue
    const projectId = m[1]
    const isPublished = (r[4] || '').toString().trim().toLowerCase() === 'published'
    const t = tally.get(projectId) || { total: 0, published: 0 }
    t.total += 1
    if (isPublished) t.published += 1
    tally.set(projectId, t)
  }
  const done = new Set<string>()
  tally.forEach((t, projectId) => {
    if (t.total > 0 && t.published === t.total) done.add(projectId)
  })
  return done
}

export async function listProjects(opts: { force?: boolean } = {}): Promise<ProjectOption[]> {
  if (!opts.force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.rows
  }

  const sheetId = process.env.PRODUCER_DASHBOARD_SHEET_ID || DEFAULT_DASHBOARD_SHEET_ID
  const projectsTab = process.env.PRODUCER_DASHBOARD_TAB || DEFAULT_PROJECTS_TAB
  const epsTab = process.env.PRODUCER_DASHBOARD_EPS_TAB || DEFAULT_EPS_TAB

  try {
    const auth = getDashboardAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    // 1) every project row
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${projectsTab}!A2:J`, // skip header row
    })
    const values = res.data.values || []

    // 2) which projects are finished — hide them. If "_EPs" is unreachable,
    //    degrade gracefully and show every project.
    let publishedProjectIds = new Set<string>()
    try {
      publishedProjectIds = await fetchFullyPublishedProjectIds(sheets, sheetId, epsTab)
    } catch (e) {
      console.error('listProjects: "_EPs" read failed — not filtering published:', e)
    }

    const rows: ProjectOption[] = []
    for (const r of values) {
      const projectId = (r[0] || '').toString().trim()
      if (!PROJECT_ID_RE.test(projectId)) continue   // strict format gate
      if (publishedProjectIds.has(projectId)) continue // hide finished projects
      rows.push({
        projectId,
        projectName: (r[1] || '').toString().trim(),
        client: r[2] ? r[2].toString().trim() : undefined,
        producer: r[5] ? r[5].toString().trim() : undefined,
        director: r[6] ? r[6].toString().trim() : undefined,
        videoType: r[7] ? r[7].toString().trim() : undefined,
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
