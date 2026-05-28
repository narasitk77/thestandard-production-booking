import { getServerSession } from 'next-auth'
import { authOptions } from './auth'
import { prisma } from './db'

export async function getSession() {
  const s = await getServerSession(authOptions)
  if (!s?.user?.email) return null
  return {
    email: s.user.email.toLowerCase(),
    name: s.user.name ?? null,
    role: ((s.user as any).role || 'USER') as 'USER' | 'ADMIN',
    id: (s.user as any).id as string | undefined,
  }
}

export async function requireAdmin() {
  const s = await getSession()
  if (!s || s.role !== 'ADMIN') return null
  return s
}

// Producer Dashboard access: admins, or users whose `position` is a Producer
// role (Producer / Co-Producer — set by an admin on the permissions page).
// Matches any position containing "producer" so variants are covered.
export async function getProducerAccess(email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  try {
    const u = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { role: true, position: true },
    })
    if (!u) return false
    if (u.role === 'ADMIN') return true
    return (u.position || '').toLowerCase().includes('producer')
  } catch {
    return false
  }
}

// Upload access (v1.35.2): the set of users who can upload footage via the
// booking detail page. Limited to people who actually shoot/record:
//   - any ADMIN (for ops + override)
//   - any TeamMember whose roster role is 'video' or 'sound'
//
// Visibility on `/admin/[id]` is further gated on the booking having a
// CONFIRMED or COMPLETE status — uploads to PENDING/CANCELLED bookings
// don't make sense.
export async function getUploadAccess(email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  try {
    const lower = email.toLowerCase()
    const user = await prisma.user.findUnique({
      where: { email: lower },
      select: { role: true, active: true },
    })
    if (!user || !user.active) return false
    if (user.role === 'ADMIN') return true
    const member = await prisma.teamMember.findUnique({
      where: { email: lower },
      select: { role: true, active: true },
    })
    if (!member || !member.active) return false
    return member.role === 'video' || member.role === 'sound'
  } catch {
    return false
  }
}

// OT approver access (v1.33.4): the set of users who can approve/reject OT
// records and see the cover-sheet overview at /ot/admin.
//
// Granted to:
//   - any ADMIN (so narasit.k and other full admins keep full access), or
//   - any user whose `position` field contains "manager" (case-insensitive)
//
// The position-based path matches the existing `getProducerAccess` pattern.
// It picks up chonlathorn.j ("Video Production Manager") and any other
// future manager without needing a code change — the admin sets their
// position and the gate flips automatically. Approver scope is narrow on
// purpose: they can act on OT and see the OT overview, but the booking
// `/admin` console + dashboard + user roster CRUD stay ADMIN-only.
export async function getOTApproverAccess(email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  try {
    const u = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { role: true, position: true, active: true },
    })
    if (!u || !u.active) return false
    if (u.role === 'ADMIN') return true
    return (u.position || '').toLowerCase().includes('manager')
  } catch {
    return false
  }
}

// Server-side gate for OT approver routes — analogous to requireAdmin().
// Returns the session when the caller is an OT approver, null otherwise.
// Replaces `requireAdmin()` everywhere the gate is "can act on OT" rather
// than "full admin".
export async function requireOTApprover() {
  const s = await getSession()
  if (!s) return null
  const ok = await getOTApproverAccess(s.email)
  return ok ? s : null
}
