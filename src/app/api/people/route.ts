import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { listPeople, invalidatePeopleCache } from '@/lib/people'

/**
 * GET /api/people?refresh=1
 *
 * Returns Producer / Director dropdown options for the booking form.
 * Source of truth = Producer Dashboard sheet, "_Users" tab.
 * Cached server-side for 5 min; ?refresh=1 forces a re-fetch.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const force = new URL(request.url).searchParams.get('refresh') === '1'
  if (force) invalidatePeopleCache()

  const people = await listPeople({ force })
  const byRole = (role: string) =>
    people
      .filter(p => p.role.toLowerCase() === role.toLowerCase())
      .map(p => ({ email: p.email, nickname: p.nickname }))

  return NextResponse.json({
    producers: byRole('Producer'),
    directors: byRole('Director'),
  })
}
