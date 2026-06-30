import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { canViewBooking } from '@/lib/booking-access'
import { missingCrewRoles, CREW_ROLE_TH } from '@/lib/crew-gaps'
import { freelancerEmails } from '@/lib/freelancers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bookings/[id]/crew-status — which required crew roles still have nobody
 * assigned, so the queue assigner sees "ยังขาดช่างภาพ / ช่างเสียง …" on a CONFIRMED
 * booking and adds the right people. Resolves assigned STAFF emails to their
 * User.position; freelancers carry no position (returned as a count so the UI can
 * soften the hint). Read-scope = canViewBooking.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        status: true, deletedAt: true, crewRequired: true, assignedEmails: true,
        freelancers: true, createdByEmail: true, producerEmail: true,
      },
    })
    if (!booking || booking.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!canViewBooking(session, booking)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Staff = assigned emails that aren't freelancers (freelancers have no position).
    const flEmails = new Set(freelancerEmails((booking.freelancers as any) || []).map(e => e.toLowerCase()))
    const staffEmails = (booking.assignedEmails || []).filter(e => e && !flEmails.has(e.toLowerCase()))

    const staff = staffEmails.length
      ? await prisma.user.findMany({ where: { email: { in: staffEmails.map(e => e.toLowerCase()) } }, select: { position: true } })
      : []

    const missing = missingCrewRoles(booking.crewRequired, staff.map(s => s.position))
    return NextResponse.json({
      status: booking.status,
      required: booking.crewRequired || [],
      missing,
      missingTh: missing.map(r => CREW_ROLE_TH[r] || r),
      freelancerCount: flEmails.size,
    })
  } catch (e: any) {
    console.error('GET /api/bookings/[id]/crew-status error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
