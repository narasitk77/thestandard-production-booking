import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { listProjects, invalidateProjectsCache } from '@/lib/projects'

/**
 * GET /api/projects?refresh=1
 *
 * Returns the dropdown options for the Project ID field on the booking form.
 * Source of truth = Producer Dashboard sheet, "All Projects" tab.
 * Cached server-side for 5 min; ?refresh=1 forces a re-fetch.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = new URL(request.url).searchParams.get('refresh') === '1'
  if (force) invalidateProjectsCache()

  const projects = await listProjects({ force })
  return NextResponse.json({ projects, total: projects.length })
}
