/**
 * Project Episodes — read-only lister from the Producer Dashboard sheet.
 * ---------------------------------------------------------------------
 * Content Agency bookings SELECT existing episodes of a project (the
 * episodes are created upstream by the Producer/Director in the Dashboard
 * UI, not by this app). This module reads the per-producer "PD <name>"
 * tabs (source of truth) plus the legacy "_EPs" tab so the booking
 * wizard can offer the project's still-bookable episodes.
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

const EPISODE_ID_RE = /^PP-\d{2}-\d{3}-[A-Z]\d{2,}$/

/**
 * THE booking rule, in one place: an episode stops being bookable ONLY
 * when its status is "Published" (case-insensitive, surrounding
 * whitespace ignored). Any other value — Pending, Pre-production,
 * Production, Post-production, blank, or a status invented next month —
 * keeps the episode bookable. Don't add exclusions here without a
 * product decision.
 */
export function isPublishedStatus(status: string | null | undefined): boolean {
  return String(status ?? '').trim().toLowerCase() === 'published'
}

/**
 * Bucket an episode status for display/stats (Sheet Monitor). Every
 * status falls into exactly ONE bucket — unknown/blank statuses land in
 * "other" so an episode can never be invisible in counts while still
 * being bookable (only "published" blocks booking; see isPublishedStatus).
 * Pure — exported for tests.
 */
export type EpStatusBucket =
  | 'pending' | 'preProduction' | 'production' | 'postProduction' | 'published' | 'other'

export function bucketEpisodeStatus(status: string | null | undefined): EpStatusBucket {
  const s = String(status ?? '').trim().toLowerCase()
  if (s.includes('pre')) return 'preProduction'
  if (s === 'production') return 'production'
  if (s.includes('post')) return 'postProduction'
  if (s === 'published') return 'published'
  if (s === 'pending') return 'pending'
  return 'other'
}

/**
 * Which tabs hold episode rows: every per-producer "PD <name>" tab plus
 * the legacy "_EPs" tab (kept as fallback while it still has rows the PD
 * tabs may not). Pure — exported for tests.
 */
export function selectEpisodeTabs(titles: string[]): string[] {
  const tabs = titles.filter(t => /^PD\s/.test(t))
  const epsTab = process.env.PRODUCER_DASHBOARD_EPS_TAB || '_EPs'
  if (titles.includes(epsTab)) tabs.push(epsTab)
  return tabs
}

/**
 * Parse episode rows out of raw tab values (one string[][] per tab, in
 * tab order — earlier tabs win on duplicate Episode IDs). Each tab's
 * columns are resolved from its own header row, so differently-laid-out
 * tabs can be mixed. Rows whose Episode ID doesn't match PP-YY-NNN-XNN
 * are ignored (filters header/banner/junk rows). Pure — exported for tests.
 */
export function parseEpisodeTabs(tabValues: string[][][]): ProjectEpisode[] {
  const byId = new Map<string, ProjectEpisode>()
  for (const values of tabValues) {
    const cols = resolveEpsColumns(values[0])
    for (const row of values.slice(1)) {
      const episodeId = String(row[cols.episodeId] || '').trim()
      if (!EPISODE_ID_RE.test(episodeId) || byId.has(episodeId)) continue
      const typeMatch = episodeId.match(/-([A-Za-z]+)\d+$/)
      byId.set(episodeId, {
        episodeId,
        type: typeMatch ? typeMatch[1].toUpperCase() : '',
        status: String(row[cols.status] || '').trim(),
        ep: String(row[cols.ep] || '').trim(),
        productCode: String(row[cols.productCode] || '').trim(),
        projectName: String(row[cols.projectName] || '').trim(),
      })
    }
  }
  return Array.from(byId.values())
}

/**
 * A project's still-bookable episodes: belongs to the project and is not
 * Published. Pure — exported for tests.
 */
export function bookableEpisodesFor(episodes: ProjectEpisode[], projectId: string): ProjectEpisode[] {
  const prefix = `${projectId}-`
  return episodes.filter(e => e.episodeId.startsWith(prefix) && !isPublishedStatus(e.status))
}

type SheetsClient = ReturnType<typeof google.sheets>

// Short-lived all-rows cache (keyed by sheet id). The booking form, the
// project-dropdown filter, and the Sheet Monitor all read the same tabs;
// without this, one dashboard refresh + form open costs ~6 Sheets read
// requests and a burst can trip the 60-reads/min/user quota (observed
// 2026-06-10 while load-testing the booking rule). 30s of staleness is
// fine — episode statuses change on human timescales.
const ROWS_CACHE_TTL_MS = 30_000
let rowsCache: { ts: number; sheetId: string; rows: ProjectEpisode[] } | null = null

export function invalidateEpisodeRowsCache() {
  rowsCache = null
}

/**
 * Read EVERY episode row from the Producer Dashboard (v1.42.2).
 *
 * Episodes are authored on the per-producer "PD <name>" tabs. The sheet's
 * own PD→"_EPs" sync automation stopped copying new rows in May 2026
 * (see "_Update Log": rows logged as "skipped"), so "_EPs" only holds
 * legacy episodes — which made every new project look like it had no
 * bookable episodes. Read the PD tabs as the source of truth and keep
 * "_EPs" as a legacy fallback; on duplicate Episode IDs the PD row wins
 * (fresher status). Each tab's columns are resolved from its own header
 * row, so the two different layouts (PD: Episode ID col C / Status col H;
 * _EPs: Episode ID col N / Status col E) both work.
 */
export async function fetchAllEpisodeRows(
  sheets: SheetsClient,
  spreadsheetId: string,
): Promise<ProjectEpisode[]> {
  if (rowsCache && rowsCache.sheetId === spreadsheetId && Date.now() - rowsCache.ts < ROWS_CACHE_TTL_MS) {
    return rowsCache.rows
  }
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  })
  const titles = (meta.data.sheets || [])
    .map(s => s.properties?.title || '')
    .filter(Boolean)
  const tabs = selectEpisodeTabs(titles)
  if (tabs.length === 0) {
    // The Dashboard restructure removed/renamed every episode tab — that's
    // an integration break, not "no episodes". Throw so callers degrade
    // loudly instead of quietly offering nothing to book.
    throw new Error(
      `no episode tabs found (expected "PD <name>" tabs or "_EPs") — sheet tabs: ${titles.join(', ')}`,
    )
  }

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map(t => `'${t.replace(/'/g, "''")}'!A1:R`),
  })

  const rows = parseEpisodeTabs(
    (res.data.valueRanges || []).map(vr => (vr.values as string[][]) || []),
  )
  rowsCache = { ts: Date.now(), sheetId: spreadsheetId, rows }
  return rows
}

export type ListEpisodesResult =
  | { ok: true; episodes: ProjectEpisode[] }
  | { ok: false; error: string }

// List a project's episodes from the Producer Dashboard (PD tabs + legacy
// "_EPs" — see fetchAllEpisodeRows), EXCLUDING ones already Published
// (those can't be booked for a new shoot).
export async function listProjectEpisodes(projectId: string): Promise<ListEpisodesResult> {
  const pid = String(projectId || '').trim()
  if (!/^PP-\d{2}-\d{3}$/.test(pid)) return { ok: false, error: `bad projectId: ${pid}` }
  if (!hasCredentials()) return { ok: false, error: 'Google service account not configured' }

  try {
    const spreadsheetId = getSheetId()
    const sheets = google.sheets({ version: 'v4', auth: getAuth() })
    const all = await fetchAllEpisodeRows(sheets, spreadsheetId)
    return { ok: true, episodes: bookableEpisodesFor(all, pid) }
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
