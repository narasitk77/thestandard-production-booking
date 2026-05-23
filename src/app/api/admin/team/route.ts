import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ROLE_ORDER } from '@/lib/team-roster'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/team — list crew assignment roster.
 *
 * Admin-only. Returns ALL members (including inactive) so /admin/team can
 * show the deactivated rows for re-activation; the /admin/[id] assign UI
 * filters out `active: false` client-side.
 *
 * Ordered by `(role index from ROLE_ORDER, sort, name)` so the list is
 * stable across queries — admins see the same order they'd expect on
 * /admin/[id]'s assign sections.
 */
export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const members = await prisma.teamMember.findMany({
    orderBy: [{ sort: 'asc' }, { name: 'asc' }],
  })
  // Sort by ROLE_ORDER index (Prisma can't sort by an in-memory array).
  members.sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a.role as any)
    const bi = ROLE_ORDER.indexOf(b.role as any)
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    if (a.sort !== b.sort) return a.sort - b.sort
    return a.name.localeCompare(b.name)
  })
  return NextResponse.json({ members })
}

/**
 * POST /api/admin/team — create a new team member.
 *
 * Body: { email, name, role, sort?, active? }
 * Email is unique; duplicate POST returns 409.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  try {
    const body = await request.json()
    const email = String(body.email || '').trim().toLowerCase()
    const name = String(body.name || '').trim()
    const role = String(body.role || '').trim()
    if (!email || !name || !role) {
      return NextResponse.json(
        { error: 'email, name, and role are required' },
        { status: 400 },
      )
    }
    if (!ROLE_ORDER.includes(role as any)) {
      return NextResponse.json(
        { error: `Unknown role "${role}". Valid: ${ROLE_ORDER.join(', ')}` },
        { status: 400 },
      )
    }
    const existing = await prisma.teamMember.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json(
        { error: `A team member with email ${email} already exists` },
        { status: 409 },
      )
    }
    const member = await prisma.teamMember.create({
      data: {
        email,
        name,
        role,
        sort: Number(body.sort ?? 0),
        active: body.active !== false,
      },
    })
    return NextResponse.json({ member }, { status: 201 })
  } catch (e: any) {
    console.error('POST /api/admin/team error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
