import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireConsole } from '@/lib/session'
import { missingCrewRoles, CREW_ROLE_TH } from '@/lib/crew-gaps'
import { freelancerEmails } from '@/lib/freelancers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bookings/crew-gaps — for the queue's CONFIRMED tab: which active
 * CONFIRMED/ASSIGNED bookings still have a required crew role with nobody
 * assigned. Batch-resolves every assigned staff email's position in ONE query,
 * then computes the gaps per booking. Returns only bookings that HAVE gaps.
 * Console-gated (the assigners). Keyed by booking id so the queue can filter +
 * badge its cards without a fetch per booking.
 */
export async function GET() {
  const session = await requireConsole()
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const bookings = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'ASSIGNED'] }, deletedAt: null },
    select: { id: true, crewRequired: true, assignedEmails: true, freelancers: true },
  })

  // Collect every assigned STAFF email (drop freelancers — no position) and
  // resolve their positions in a single query.
  const allEmails = new Set<string>()
  const perBooking = bookings.map(b => {
    const fl = new Set(freelancerEmails((b.freelancers as any) || []).map(e => e.toLowerCase()))
    const staff = (b.assignedEmails || []).filter(e => e && !fl.has(e.toLowerCase())).map(e => e.toLowerCase())
    staff.forEach(e => allEmails.add(e))
    return { id: b.id, crewRequired: b.crewRequired, staff }
  })
  const users = allEmails.size
    ? await prisma.user.findMany({ where: { email: { in: Array.from(allEmails) } }, select: { email: true, position: true } })
    : []
  const posByEmail = new Map(users.map(u => [u.email.toLowerCase(), u.position]))

  const gaps: Record<string, { missing: string[]; missingTh: string[] }> = {}
  for (const b of perBooking) {
    const missing = missingCrewRoles(b.crewRequired, b.staff.map(e => posByEmail.get(e)))
    if (missing.length) gaps[b.id] = { missing, missingTh: missing.map(r => CREW_ROLE_TH[r] || r) }
  }
  return NextResponse.json({ gaps, count: Object.keys(gaps).length })
}
