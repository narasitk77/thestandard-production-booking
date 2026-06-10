/**
 * E2E verification of the booking-eligibility rule against the REAL
 * Producer Dashboard sheet (run: npx tsx scripts/verify-booking-rule.ts).
 *
 * Invariant under test, for EVERY project that has episodes:
 *   bookable(project) === all episodes of that project whose status is
 *   anything except "Published".
 *
 * The "expected" side comes from an INDEPENDENT parse of the raw tab
 * values (own header lookup, own row walk) so a bug in the app's column
 * resolution can't hide by agreeing with itself. The "actual" side is
 * the app's real path: fetchAllEpisodeRows → bookableEpisodesFor, plus
 * one full listProjectEpisodes call per producer tab as a smoke test of
 * the complete API path (auth, env, tab discovery).
 *
 * Also checks the project dropdown rule: a project on "All Projects" is
 * hidden only when ALL of its episodes are Published.
 *
 * Total Sheets API reads: ~6 (stays far under the 60/min/user quota).
 * Exits non-zero on any violation.
 */
import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

const pidOf = (episodeId: string) => episodeId.slice(0, 9) // PP-YY-NNN

async function main() {
  const { google } = await import('googleapis')
  const { fetchAllEpisodeRows, bookableEpisodesFor, listProjectEpisodes, isPublishedStatus } =
    await import('../src/lib/dashboard-episodes')
  const { getProducerDashboardSheetId } = await import('../src/lib/google-config')

  const sheetId = getProducerDashboardSheetId()
  const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    }),
  })

  // ---- independent read: own tab discovery + own parsing -----------------
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
  const titles = (meta.data.sheets || []).map(s => s.properties?.title || '')
  const epTabs = titles.filter(t => t.startsWith('PD ')).concat(titles.filter(t => t === '_EPs'))
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: epTabs.map(t => `'${t}'!A1:R`),
  })

  // expected: episodeId -> status, first tab wins (mirrors PD-over-_EPs precedence
  // but via an independent implementation: exact-name header indexOf)
  const expected = new Map<string, string>()
  for (const vr of res.data.valueRanges || []) {
    const values = (vr.values as string[][]) || []
    const header = (values[0] || []).map(h => String(h).trim())
    const idIdx = header.indexOf('Episode ID')
    const stIdx = header.indexOf('Status')
    if (idIdx < 0 || stIdx < 0) continue
    for (const row of values.slice(1)) {
      const id = String(row[idIdx] || '').trim()
      if (!/^PP-\d{2}-\d{3}-[A-Z]\d{2,}$/.test(id) || expected.has(id)) continue
      expected.set(id, String(row[stIdx] || '').trim())
    }
  }

  // ---- app path -----------------------------------------------------------
  const all = await fetchAllEpisodeRows(sheets, sheetId)
  const appById = new Map(all.map(e => [e.episodeId, e]))

  console.log(`sheet ${sheetId.slice(0, 6)}… · tabs: ${epTabs.join(', ')}`)
  console.log(`independent parse: ${expected.size} episodes · app parse: ${all.length} episodes`)

  let failures = 0
  const fail = (msg: string) => { failures++; console.error(`✗ ${msg}`) }

  // 1) both reads see the same episode set
  for (const id of Array.from(expected.keys())) if (!appById.has(id)) fail(`app missed episode ${id}`)
  for (const id of Array.from(appById.keys())) if (!expected.has(id)) fail(`app invented episode ${id}`)

  // 2) per-project: bookable === everything except Published
  const projects = new Set(Array.from(expected.keys()).map(pidOf))
  for (const pid of Array.from(projects).sort()) {
    const want = Array.from(expected.entries())
      .filter(([id, st]) => pidOf(id) === pid && st.toLowerCase() !== 'published')
      .map(([id]) => id)
      .sort()
    const got = bookableEpisodesFor(all, pid).map(e => e.episodeId).sort()
    if (JSON.stringify(want) === JSON.stringify(got)) {
      const total = Array.from(expected.keys()).filter(id => pidOf(id) === pid).length
      console.log(`✓ ${pid}: ${got.length}/${total} bookable (${total - got.length} published excluded)`)
    } else {
      fail(`${pid} mismatch\n    expected: ${want.join(', ')}\n    actual:   ${got.join(', ')}`)
    }
  }

  // 3) full-path smoke test: one project per PD tab through listProjectEpisodes
  const samples = ['PP-26-025', 'PP-26-016', 'PP-26-024'].filter(p => projects.has(p))
  for (const pid of samples) {
    const r = await listProjectEpisodes(pid)
    if (!r.ok) { fail(`listProjectEpisodes(${pid}) errored: ${r.error}`); continue }
    const got = r.episodes.map(e => e.episodeId).sort()
    const want = Array.from(expected.entries())
      .filter(([id, st]) => pidOf(id) === pid && st.toLowerCase() !== 'published')
      .map(([id]) => id).sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`listProjectEpisodes(${pid}) mismatch\n    expected: ${want.join(', ')}\n    actual:   ${got.join(', ')}`)
    } else {
      console.log(`✓ listProjectEpisodes(${pid}) full path OK (${got.length} episodes)`)
    }
  }

  // 4) dropdown rule: hidden ⇔ all episodes Published (only for projects on "All Projects")
  const { listProjects } = await import('../src/lib/projects')
  const allProjectsRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'All Projects'!A2:A` })
  const onAllProjects = new Set(
    (allProjectsRes.data.values || []).map(r => String(r[0] || '').trim()).filter(p => /^PP-\d{2}-\d{3}$/.test(p)),
  )
  const dropdown = new Set((await listProjects({ force: true })).map(p => p.projectId))
  for (const pid of Array.from(projects).sort()) {
    if (!onAllProjects.has(pid)) continue
    const eps = Array.from(expected.entries()).filter(([id]) => pidOf(id) === pid)
    const allPublished = eps.every(([, st]) => isPublishedStatus(st))
    if (allPublished && dropdown.has(pid)) fail(`${pid}: fully Published but still in the booking dropdown`)
    if (!allPublished && !dropdown.has(pid)) fail(`${pid}: has bookable episodes but missing from the dropdown`)
  }
  console.log(`✓ dropdown rule checked for ${onAllProjects.size} projects on "All Projects"`)

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} violation(s)`)
    process.exit(1)
  }
  console.log('\nOK: only Published episodes are excluded from booking — everywhere.')
}

main().catch(e => { console.error(e); process.exit(1) })
