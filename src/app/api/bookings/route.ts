import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { autoCompleteBookings } from '@/lib/booking-complete'
import { createBookingFromPayload } from '@/lib/create-booking'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Auto-complete past CONFIRMED bookings (lazy, fire-and-forget)
    autoCompleteBookings().catch(e => console.error('autoCompleteBookings error:', e))

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') ?? '1')
    const limit = parseInt(searchParams.get('limit') ?? '20')
    const status = searchParams.get('status')
    const outlet = searchParams.get('outlet')
    const date = searchParams.get('date')
    const scope = searchParams.get('scope') // 'mine' | 'all' | 'producer'
    // v1.51 — deleted=1 (ADMIN only) lists soft-deleted bookings for the
    // Deleted tab on /admin; every other request filters them out.
    const showDeleted = searchParams.get('deleted') === '1' && session.role === 'ADMIN'
    // v1.56 — routine filter: 'only' = routine bookings, 'exclude' = hide them.
    // Default (unset) includes both, so calendar/dashboard/home are unchanged;
    // /admin uses 'exclude' for status tabs and 'only' for its Routine tab.
    const routine = searchParams.get('routine')

    // scope=producer → only shoots where this user is the Producer (their own
    // email — safe, no leak). Otherwise plain USERs are restricted to their own
    // bookings + confirmed bookings; console tiers (no scope) see everything —
    // the /admin queue and dashboard need the full set (v1.50, was ADMIN-only).
    const userFilter = scope === 'producer'
      ? { producerEmail: { equals: session.email, mode: 'insensitive' as const } }
      : hasConsoleAccess(session.role) && scope !== 'mine'
        ? {}
        : {
            OR: [
              { createdByEmail: session.email },
              { assignedEmails: { has: session.email } },
              ...(scope === 'mine' ? [] : [{ status: 'CONFIRMED' as const }]),
            ],
          }

    // ?cancelRequested=1 — the "ขอยกเลิก" tab: bookings someone asked to cancel
    // that aren't already cancelled.
    const cancelRequested = searchParams.get('cancelRequested') === '1'

    const where = {
      ...userFilter,
      deletedAt: showDeleted ? { not: null } : null,
      ...(routine === 'only' && { isRoutine: true }),
      ...(routine === 'exclude' && { isRoutine: false }),
      ...(cancelRequested && { cancelRequestedAt: { not: null }, status: { not: 'CANCELLED' as const } }),
      ...(status && { status: status as any }),
      ...(outlet && { outlet: { code: outlet } }),
      ...(date && { shootDate: new Date(date) }),
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          outlet: true,
          program: true,
          episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
        },
        orderBy: [{ shootDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.booking.count({ where }),
    ])

    return NextResponse.json({ bookings, total, page, limit })
  } catch (error) {
    console.error('GET /api/bookings error:', error)
    return NextResponse.json({ error: 'Failed to fetch bookings' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await request.json()

    // Creation logic lives in src/lib/create-booking.ts (v1.49.0) so the
    // MCP server and this route share one implementation.
    const result = await createBookingFromPayload(body, session.email)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ booking: result.booking }, { status: 201 })
  } catch (error) {
    console.error('POST /api/bookings error:', error)
    return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 })
  }
}
