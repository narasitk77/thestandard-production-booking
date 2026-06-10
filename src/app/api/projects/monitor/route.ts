import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { getProducerDashboardSheetId } from '@/lib/google-config'
import { getSession } from '@/lib/session'
import { invalidateProjectsCache } from '@/lib/projects'
import { resolveEpsColumns } from '@/lib/dashboard-episodes'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

const PROJECT_ID_RE = /^PP-\d{2}-\d{3}$/
const EPISODE_ID_RE = /^(PP-\d{2}-\d{3})-[A-Z]\d{2,}$/

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

export type EpCounts = {
  preProduction: number
  production: number
  postProduction: number
  published: number
}

export type ProjectMonitorRow = {
  projectId: string
  projectName: string
  client?: string
  producer?: string
  director?: string
  videoType?: string
  progress?: string
  epCounts: EpCounts
  totalEps: number
  bookingCount: number
  isBookable: boolean
}

/**
 * GET /api/projects/monitor
 *
 * Reads ALL projects from the Producer Dashboard sheet (including Published)
 * and joins them with episode-status counts from _EPs + booking counts from DB.
 *
 * Used by the Sheet Data Monitor section in /dashboard.
 *
 * ?refresh=1 — also invalidates the server-side booking-form project cache
 *   so the next /new booking form load sees the freshest project list.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  if (searchParams.get('refresh') === '1') invalidateProjectsCache()

  try {
    const sheetId = getProducerDashboardSheetId()
    const projectsTab = process.env.PRODUCER_DASHBOARD_TAB || 'All Projects'
    const epsTab = process.env.PRODUCER_DASHBOARD_EPS_TAB || '_EPs'

    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    const [projectsRes, epsRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${projectsTab}!A2:J` }),
      sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${epsTab}!A1:R` }),
    ])

    const projectRows = projectsRes.data.values || []
    const epValues = epsRes.data.values || []
    const epCols = resolveEpsColumns(epValues[0])
    const epRows = epValues.slice(1)

    // Episode counts per project
    const epCounts = new Map<string, EpCounts>()
    for (const r of epRows) {
      const episodeId = (r[epCols.episodeId] || '').toString().trim()
      const m = episodeId.match(EPISODE_ID_RE)
      if (!m) continue
      const pid = m[1]
      const status = (r[epCols.status] || '').toString().trim().toLowerCase()
      if (!epCounts.has(pid)) {
        epCounts.set(pid, { preProduction: 0, production: 0, postProduction: 0, published: 0 })
      }
      const c = epCounts.get(pid)!
      if (status.includes('pre')) c.preProduction++
      else if (status === 'production') c.production++
      else if (status.includes('post')) c.postProduction++
      else if (status === 'published') c.published++
    }

    // Build project list (all — including Published)
    const allProjectIds: string[] = []
    const projectMap = new Map<string, ProjectMonitorRow>()

    for (const r of projectRows) {
      const projectId = (r[0] || '').toString().trim()
      if (!PROJECT_ID_RE.test(projectId)) continue
      allProjectIds.push(projectId)

      const counts = epCounts.get(projectId) ?? { preProduction: 0, production: 0, postProduction: 0, published: 0 }
      const totalEps = counts.preProduction + counts.production + counts.postProduction + counts.published
      const allPublished = totalEps > 0 && counts.published === totalEps

      projectMap.set(projectId, {
        projectId,
        projectName: (r[1] || '').toString().trim(),
        client: r[2] ? r[2].toString().trim() : undefined,
        producer: r[5] ? r[5].toString().trim() : undefined,
        director: r[6] ? r[6].toString().trim() : undefined,
        videoType: r[7] ? r[7].toString().trim() : undefined,
        progress: r[8] ? r[8].toString().trim() : undefined,
        epCounts: counts,
        totalEps,
        bookingCount: 0,
        isBookable: !allPublished,
      })
    }

    // DB booking counts per project (non-cancelled only)
    if (allProjectIds.length > 0) {
      const rows = await prisma.booking.groupBy({
        by: ['projectId'],
        where: { projectId: { in: allProjectIds }, status: { not: 'CANCELLED' } },
        _count: { id: true },
      })
      for (const row of rows) {
        if (row.projectId && projectMap.has(row.projectId)) {
          projectMap.get(row.projectId)!.bookingCount = row._count.id
        }
      }
    }

    return NextResponse.json({
      projects: Array.from(projectMap.values()),
      total: projectMap.size,
      ts: new Date().toISOString(),
    })
  } catch (error) {
    console.error('GET /api/projects/monitor error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
