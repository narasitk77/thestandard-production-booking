import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { INITIAL_TEAM_ROSTER } from '@/lib/team-roster'

export const dynamic = 'force-dynamic'

/**
 * GET /api/team/directors — the Video Director roster for the booking wizard's
 * Director picker (any logged-in user; producers book, so this can't sit behind
 * the console-only /api/admin/team). Names + work emails only — the same list
 * the assign UI shows. DB TeamMember is the source of truth (editable at
 * /admin/team); the seed roster is the last-resort fallback, mirroring the
 * assign UI's behavior.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    // active only — a director removed at /admin/team must not stay pickable.
    // An EMPTY result is returned as-is (the wizard just hides the picker);
    // the seed roster is a DB-ERROR fallback only, so intentionally-removed
    // members can't resurrect through it.
    const members = await prisma.teamMember.findMany({
      where: { role: 'director', active: true },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      select: { name: true, email: true },
    })
    return NextResponse.json({ directors: members })
  } catch (e: any) {
    console.error('GET /api/team/directors error (falling back to seed roster):', e?.message || e)
    return NextResponse.json({
      directors: INITIAL_TEAM_ROSTER.filter(m => m.role === 'director').map(({ name, email }) => ({ name, email })),
    })
  }
}
