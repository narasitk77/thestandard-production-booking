import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { ROLE_ORDER } from '@/lib/team-roster'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/team/[id] — update a team member.
 *
 * Body: any subset of { name, role, sort, active }
 * Email is NOT mutable (it's the canonical id used by booking.assignedEmails);
 * to "rename" an email, deactivate the old row and create a new one.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  try {
    const body = await request.json()
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string') data.name = body.name.trim()
    if (typeof body.role === 'string') {
      const role = body.role.trim()
      if (!ROLE_ORDER.includes(role as any)) {
        return NextResponse.json(
          { error: `Unknown role "${role}". Valid: ${ROLE_ORDER.join(', ')}` },
          { status: 400 },
        )
      }
      data.role = role
    }
    if (typeof body.sort === 'number') data.sort = body.sort
    if (typeof body.active === 'boolean') data.active = body.active
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No editable fields provided' }, { status: 400 })
    }
    const member = await prisma.teamMember.update({
      where: { id: params.id },
      data,
    })
    return NextResponse.json({ member })
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }
    console.error('PATCH /api/admin/team/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/team/[id] — soft-delete (set active=false).
 *
 * We never hard-delete because historical bookings reference these emails
 * via `assignedEmails`. Soft delete just hides the member from the assign
 * UI while preserving past assignment history + audit trail.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  try {
    const member = await prisma.teamMember.update({
      where: { id: params.id },
      data: { active: false },
    })
    return NextResponse.json({ member })
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }
    console.error('DELETE /api/admin/team/[id] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
