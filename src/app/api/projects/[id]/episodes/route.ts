/**
 * GET /api/projects/:id/episodes
 *
 * Lists a project's episodes from the "_EPs" tab, excluding Published ones, so
 * the booking form can let the user pick which existing episodes a shoot
 * (Production) covers. Auth-gated.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const result = await listProjectEpisodes(params.id)
    if (!result.ok) {
      return NextResponse.json({ error: result.error, episodes: [] }, { status: 502 })
    }
    return NextResponse.json({ episodes: result.episodes })
  } catch (error) {
    console.error('GET /api/projects/[id]/episodes error:', error)
    return NextResponse.json({ error: 'Failed to list episodes', episodes: [] }, { status: 500 })
  }
}
