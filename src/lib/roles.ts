// Role tier model (v1.38).
//
// Hierarchy (rank 0 = most authority):
//   ADMIN(0) > SUPPORT(1) > MANAGER(2) > COORDINATOR(3) > USER(4)
//
// Capability summary:
//   - ADMIN        full console + full role management + OT approve
//   - SUPPORT      full console, NO OT approve, NO role management (staff helper)
//                  — protected: only ADMIN can edit a SUPPORT user
//   - MANAGER      full console + OT approve + manage COORDINATOR/USER (up to Coordinator)
//   - COORDINATOR  full console, NO OT approve, may edit USER only (no promotion)
//   - USER         no console access
//
// Note: role rank gates WHO CAN EDIT WHOM (you only manage roles strictly below
// you, and only if you have role-management capability), while the capability
// helpers below gate WHAT a role can do (console / OT / managing roles at all).

export type Role = 'ADMIN' | 'SUPPORT' | 'MANAGER' | 'COORDINATOR' | 'USER'

export const ROLES: Role[] = ['ADMIN', 'SUPPORT', 'MANAGER', 'COORDINATOR', 'USER']

export const ROLE_RANK: Record<Role, number> = {
  ADMIN: 0,
  SUPPORT: 1,
  MANAGER: 2,
  COORDINATOR: 3,
  USER: 4,
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  SUPPORT: 'Support',
  MANAGER: 'Manager',
  COORDINATOR: 'Coordinator',
  USER: 'User',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value)
}

/** Everyone except a plain USER can use the admin console. */
export function hasConsoleAccess(role?: string | null): boolean {
  return role === 'ADMIN' || role === 'SUPPORT' || role === 'MANAGER' || role === 'COORDINATOR'
}

/** OT approval is a Manager/Admin duty — Coordinator + Support cannot approve. */
export function canApproveOTByRole(role?: string | null): boolean {
  return role === 'ADMIN' || role === 'MANAGER'
}

/**
 * Position-based OT approval (legacy path for managers tagged by position before
 * the MANAGER role existed, e.g. "Video Production Manager"). EXCLUDES "Project
 * Manager" (PM office) — they run projects, they don't approve crew overtime.
 */
export function positionGrantsOT(position?: string | null): boolean {
  const pos = (position || '').toLowerCase()
  return pos.includes('manager') && !pos.includes('project manager')
}

/** Can this actor manage roles at all (i.e. see edit controls on the Permissions page)? */
export function canManageRoles(actorRole?: string | null): boolean {
  return actorRole === 'ADMIN' || actorRole === 'MANAGER' || actorRole === 'COORDINATOR'
}

/**
 * Can `actorRole` edit a user whose current role is `targetRole`
 * (change their role / active / profile fields)?
 *   - ADMIN: anyone
 *   - MANAGER: Coordinator + User
 *   - COORDINATOR: User only
 *   - SUPPORT / USER: nobody
 */
export function canEditUser(actorRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  switch (actorRole) {
    case 'ADMIN':
      return true
    case 'MANAGER':
      return targetRole === 'COORDINATOR' || targetRole === 'USER'
    case 'COORDINATOR':
      return targetRole === 'USER'
    default:
      return false
  }
}

/** Roles this actor may assign to a user they're allowed to edit. */
export function assignableRoles(actorRole: string | null | undefined): Role[] {
  switch (actorRole) {
    case 'ADMIN':
      return ['ADMIN', 'SUPPORT', 'MANAGER', 'COORDINATOR', 'USER']
    case 'MANAGER':
      return ['COORDINATOR', 'USER'] // up to Coordinator — cannot grant Manager/Support/Admin
    case 'COORDINATOR':
      return ['USER'] // no promotion — can only keep/return someone to USER
    default:
      return []
  }
}

/** Can this actor create/add a brand-new user with `newRole`? Coordinator cannot add (ปรับเพิ่มไม่ได้). */
export function canAddUser(actorRole: string | null | undefined, newRole: string): boolean {
  if (actorRole === 'ADMIN' || actorRole === 'MANAGER') {
    return (assignableRoles(actorRole) as string[]).includes(newRole)
  }
  return false
}
