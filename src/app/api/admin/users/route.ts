import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess, canEditUser, assignableRoles, canAddUser, isRole } from '@/lib/roles'

// Viewing the roster: any console tier (Admin / Support / Manager / Coordinator).
export async function GET() {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }
  const users = await prisma.user.findMany({ orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }] })
  return NextResponse.json({ users })
}

// Edit an existing user's role / active / profile — gated by the role matrix
// (see src/lib/roles.ts):
//   Admin → anyone · Manager → Coordinator+User · Coordinator → User only
//   Support → nobody. Role may only be set to a role the actor can assign.
export async function PATCH(request: NextRequest) {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }

  const { id, role, active, thaiName, employeeId, position } = await request.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Self-protection: never let someone demote or disable themselves (lockout).
  if (id === me.id && (active === false || (role && role !== me.role))) {
    return NextResponse.json({ error: 'Cannot change your own role or disable yourself' }, { status: 400 })
  }

  // Must be allowed to edit this target's CURRENT role.
  if (!canEditUser(me.role, target.role)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot edit a ${target.role} user` }, { status: 403 })
  }

  // When changing the role, the NEW role must be one this actor may assign.
  if (role !== undefined && role !== null && role !== target.role) {
    if (!isRole(role) || !(assignableRoles(me.role) as string[]).includes(role)) {
      return NextResponse.json({ error: `Your role (${me.role}) cannot assign role ${role}` }, { status: 403 })
    }
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(role && { role }),
      ...(active !== undefined && { active }),
      ...(thaiName !== undefined && { thaiName: thaiName?.trim() || null }),
      ...(employeeId !== undefined && { employeeId: employeeId?.trim() || null }),
      ...(position !== undefined && { position: position?.trim() || null }),
    },
  })
  return NextResponse.json({ user })
}

// Add (or re-activate) a user. Adding is a promotion act — only Admin/Manager
// may add, and only with a role they're allowed to assign. If the email already
// exists, the actor must also be allowed to edit that existing user's role.
export async function POST(request: NextRequest) {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }

  const { email, role, thaiName, employeeId, position } = await request.json()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })
  const newRole = role || 'USER'

  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, role: true },
  })

  if (existing) {
    if (!canEditUser(me.role, existing.role)) {
      return NextResponse.json({ error: `Your role (${me.role}) cannot edit a ${existing.role} user` }, { status: 403 })
    }
    if (newRole !== existing.role && !(assignableRoles(me.role) as string[]).includes(newRole)) {
      return NextResponse.json({ error: `Your role (${me.role}) cannot assign role ${newRole}` }, { status: 403 })
    }
  } else if (!canAddUser(me.role, newRole)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot add a ${newRole} user` }, { status: 403 })
  }

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      role: newRole,
      active: true,
      ...(thaiName !== undefined && { thaiName: thaiName?.trim() || null }),
      ...(employeeId !== undefined && { employeeId: employeeId?.trim() || null }),
      ...(position !== undefined && { position: position?.trim() || null }),
    },
    create: {
      email: email.toLowerCase(),
      role: newRole,
      thaiName: thaiName?.trim() || null,
      employeeId: employeeId?.trim() || null,
      position: position?.trim() || null,
    },
  })
  return NextResponse.json({ user })
}

// Soft-delete (deactivate) — same edit-matrix gate as PATCH.
export async function DELETE(request: NextRequest) {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }

  const { id } = await request.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (id === me.id) {
    return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (!canEditUser(me.role, target.role)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot deactivate a ${target.role} user` }, { status: 403 })
  }

  // Soft-delete by deactivating (preserves OT history)
  const user = await prisma.user.update({ where: { id }, data: { active: false } })
  return NextResponse.json({ user, soft: true })
}
