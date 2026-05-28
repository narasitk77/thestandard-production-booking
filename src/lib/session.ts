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

// v1.35.3 — per-booking upload gate. Combines the general capability check
// (`getUploadAccess`) with the booking-specific assignment rule so a
// videographer can only push files to bookings they're actually working on.
//
// Admin bypass: anyone with `User.role === 'ADMIN'` skips the assignment
// check (ops need to upload on behalf of crew, fix wrong filings, etc).
//
// Returns `{ ok, reason? }` so callers can either redirect/hide silently
// or surface the specific failure (good for diagnosing "I can see this
// booking on /my-bookings but the Upload button is missing — why?").
export interface UploadAccessCheck {
  ok: boolean
  reason?: 'NO_UPLOAD_ROLE' | 'NOT_ASSIGNED' | 'BAD_STATUS' | 'BOOKING_NOT_FOUND'
  isAdmin?: boolean
}

export async function canUploadToBooking(
  email: string | null | undefined,
  bookingIdOrRow:
    | string
    | { id: string; status: string; assignedEmails: string[] },
): Promise<UploadAccessCheck> {
  if (!email) return { ok: false, reason: 'NO_UPLOAD_ROLE' }
  const lower = email.toLowerCase()

  // Load user role first — admin shortcuts both the role check and the
  // assignment check.
  const user = await prisma.user.findUnique({
    where: { email: lower },
    select: { role: true, active: true },
  })
  if (!user || !user.active) return { ok: false, reason: 'NO_UPLOAD_ROLE' }
  const isAdmin = user.role === 'ADMIN'

  // For non-admins, confirm the upload-role check (video/sound)
  if (!isAdmin) {
    const member = await prisma.teamMember.findUnique({
      where: { email: lower },
      select: { role: true, active: true },
    })
    if (!member || !member.active || (member.role !== 'video' && member.role !== 'sound')) {
      return { ok: false, reason: 'NO_UPLOAD_ROLE' }
    }
  }

  // Load booking (caller may have already done this)
  const booking = typeof bookingIdOrRow === 'string'
    ? await prisma.booking.findUnique({
        where: { id: bookingIdOrRow },
        select: { id: true, status: true, assignedEmails: true },
      })
    : bookingIdOrRow
  if (!booking) return { ok: false, reason: 'BOOKING_NOT_FOUND', isAdmin }

  if (booking.status !== 'CONFIRMED' && booking.status !== 'COMPLETED') {
    return { ok: false, reason: 'BAD_STATUS', isAdmin }
  }

  if (isAdmin) return { ok: true, isAdmin: true }

  // Assignment check: case-insensitive membership in booking.assignedEmails
  const assigned = (booking.assignedEmails || []).map(e => e.toLowerCase())
  if (!assigned.includes(lower)) {
    return { ok: false, reason: 'NOT_ASSIGNED', isAdmin: false }
  }
  return { ok: true, isAdmin: false }
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
