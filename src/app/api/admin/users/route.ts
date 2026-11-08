import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess, canEditUser, assignableRoles, canAddUser, isRole } from '@/lib/roles'
import { OUTLET_MAP } from '@/lib/data'
import { logAudit, diffFields } from '@/lib/audit'

// v1.50 — never ship signaturePng to the client: it's the base64 e-signature
// used to sign OT records, and no caller of these routes renders it.
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  thaiName: true,
  employeeId: true,
  position: true,
  role: true,
  active: true,
  producerOutlets: true,
  signatureUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

// v1.54 — normalize + validate the producerOutlets payload: array of known
// outlet codes (see OUTLETS in src/lib/data.ts), deduped, uppercased.
// Returns null when the payload is malformed.
function parseProducerOutlets(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const codes = Array.from(new Set(value.map(v => String(v).trim().toUpperCase()).filter(Boolean)))
  if (codes.some(c => !OUTLET_MAP[c])) return null
  return codes
}

// v1.50 — a position containing "manager" mints an OT approver via the legacy
// getOTApproverAccess path, so handing it out is a promotion act: only actors
// who hold OT-approval authority themselves (Admin/Manager) may set it.
function canSetPosition(actorRole: string | null | undefined, position: unknown): boolean {
  if (typeof position !== 'string' || !/manager/i.test(position)) return true
  return actorRole === 'ADMIN' || actorRole === 'MANAGER'
}

// v1.282 — role / access edits had no audit trail at all: a promotion to ADMIN
// or a "manager" position (= OT approver, see canSetPosition) left no record of
// who granted it. One row per edit that actually changed something; entityType
// 'User' never reaches a booking timeline, so nothing here is shown to non-staff.
const USER_AUDIT_FIELDS = ['role', 'active', 'thaiName', 'employeeId', 'position', 'producerOutlets'] as const
// A new account diffs against a blank one, so a position (manager = OT approver)
// or name set at creation is on the user.add row too, not just the role.
const BLANK_USER = { role: null, active: true, thaiName: null, employeeId: null, position: null, producerOutlets: [] }
const USER_AUDIT_SELECT = { id: true, email: true, role: true, active: true, thaiName: true, employeeId: true, position: true, producerOutlets: true } as const

async function auditUserChange(
  actorEmail: string,
  before: Record<string, any> | null,
  after: { id: string; email: string; role: string } & Record<string, any>,
) {
  const diff = diffFields(before ?? BLANK_USER, after, USER_AUDIT_FIELDS)
  if (before && !diff) return
  await logAudit({
    actorEmail,
    action: before ? 'user.update' : 'user.add',
    entityType: 'User',
    entityId: after.id,
    changes: { email: after.email, ...diff },
  })
}

// Viewing the roster: any console tier (Admin / Support / Manager / Coordinator).
export async function GET() {
  const me = await getSession()
  if (!me || !hasConsoleAccess(me.role)) {
    return NextResponse.json({ error: 'Console access required' }, { status: 403 })
  }
  const users = await prisma.user.findMany({
    orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }],
    select: USER_SELECT,
  })
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

  const { id, role, active, thaiName, employeeId, position, producerOutlets } = await request.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const outlets = producerOutlets !== undefined ? parseProducerOutlets(producerOutlets) : undefined
  if (outlets === null) {
    return NextResponse.json({ error: 'producerOutlets must be an array of valid outlet codes' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id }, select: USER_AUDIT_SELECT })
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

  if (position !== undefined && !canSetPosition(me.role, position)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot grant a manager position` }, { status: 403 })
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(role && { role }),
      ...(active !== undefined && { active }),
      ...(thaiName !== undefined && { thaiName: thaiName?.trim() || null }),
      ...(employeeId !== undefined && { employeeId: employeeId?.trim() || null }),
      ...(position !== undefined && { position: position?.trim() || null }),
      ...(outlets !== undefined && { producerOutlets: outlets }),
    },
    select: USER_SELECT,
  })
  await auditUserChange(me.email, target, user)
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
    select: USER_AUDIT_SELECT,
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

  if (position !== undefined && !canSetPosition(me.role, position)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot grant a manager position` }, { status: 403 })
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
    select: USER_SELECT,
  })
  await auditUserChange(me.email, existing, user)
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

  const target = await prisma.user.findUnique({ where: { id }, select: USER_AUDIT_SELECT })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (!canEditUser(me.role, target.role)) {
    return NextResponse.json({ error: `Your role (${me.role}) cannot deactivate a ${target.role} user` }, { status: 403 })
  }

  // Soft-delete by deactivating (preserves OT history)
  const user = await prisma.user.update({ where: { id }, data: { active: false }, select: USER_SELECT })
  await auditUserChange(me.email, target, user)
  return NextResponse.json({ user, soft: true })
}
