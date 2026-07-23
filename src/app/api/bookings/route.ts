import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { autoCompleteBookings } from '@/lib/booking-complete'
import { createBookingFromPayload } from '@/lib/create-booking'
import { makeCrewNameResolver, makeProducerNickResolver, shortPersonName } from '@/lib/crew-names'

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
    // Half-open shootDate range [from, to) — used by the Week Plan to fetch just
    // the visible week (not the newest-N), so it's correct for any week + size.
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const scope = searchParams.get('scope') // 'mine' | 'all' | 'producer'
    // v1.51 — deleted=1 (ADMIN only) lists soft-deleted bookings for the
    // Deleted tab on /admin; every other request filters them out.
    const showDeleted = searchParams.get('deleted') === '1' && session.role === 'ADMIN'
    // v1.56 — routine filter: 'only' = routine bookings, 'exclude' = hide them.
    // Default (unset) includes both, so calendar/dashboard/home are unchanged;
    // /admin uses 'exclude' for status tabs and 'only' for its Routine tab.
    const routine = searchParams.get('routine')
    // v1.111 — opt-in: resolve assignedEmails → crew names for the card/list. Off by
    // default so other consumers (dashboard/calendar) don't pay the extra query.
    const withCrew = searchParams.get('withCrew') === '1'

    // scope=producer → only shoots where this user is the Producer (their own
    // email — safe, no leak). scope=mine → strictly the caller's own bookings
    // (My Bookings). Otherwise EVERY signed-in user sees EVERY live booking.
    //
    // v1.152 — transparent schedule (ops decision 2026-07-22): the calendar is
    // a shared capacity view, so a REQUESTED/ASSIGNED shoot must be as visible
    // as a CONFIRMED one. Until now plain users saw only CONFIRMED bookings
    // plus their own, so two producers could each request the same crew/day
    // without seeing the other's pending request — which is precisely what the
    // "First Come First Served" rule needs people to see. Console tiers were
    // already unrestricted; this closes the gap for everyone else.
    //
    // Detail-level protection is unchanged and lives elsewhere: adminNotes and
    // the upload rows stay behind canViewBooking (booking-access.ts), and only
    // the owner/console can EDIT. This is a read-scope change on the schedule,
    // not a permissions change.
    const userFilter = scope === 'producer'
      ? { producerEmail: { equals: session.email, mode: 'insensitive' as const } }
      : scope === 'mine'
        ? {
            OR: [
              { createdByEmail: session.email },
              { assignedEmails: { has: session.email } },
            ],
          }
        : {}

    // ?cancelRequested=1 — the "ขอยกเลิก" tab: bookings someone asked to cancel
    // that aren't already cancelled.
    const cancelRequested = searchParams.get('cancelRequested') === '1'

    // v1.109 — unified search box. v1.111 — GLOBAL: one field matches ANYTHING on
    // the booking — Production/Episode ID, internal id, episode title, project,
    // producer, location, notes, crew emails, outlet/program name. AND-wrapped so
    // it composes with the userFilter OR (restricted users) without clobbering it.
    const search = (searchParams.get('search') || '').trim()
    const ci = { contains: search, mode: 'insensitive' as const }
    const searchClause = search
      ? {
          OR: [
            { bookingCode: ci },
            { id: search },
            { episodes: { some: { episodeId: ci } } },
            { episodes: { some: { title: ci } } },
            { episodes: { some: { program: { name: ci } } } },
            { projectName: ci },
            { projectId: ci },
            { producer: ci },
            { producerEmail: ci },
            { locationName: ci },
            { notes: ci },
            { adminNotes: ci },
            { agencyRef: ci },
            { assignedEmails: { has: search.toLowerCase() } },
            { outlet: { name: ci } },
            { outlet: { code: ci } },
            { program: { name: ci } },
          ],
        }
      : null

    const where = {
      ...userFilter,
      deletedAt: showDeleted ? { not: null } : null,
      ...(routine === 'only' && { isRoutine: true }),
      ...(routine === 'exclude' && { isRoutine: false }),
      ...(cancelRequested && { cancelRequestedAt: { not: null }, status: { not: 'CANCELLED' as const } }),
      ...(status && { status: status as any }),
      ...(outlet && { outlet: { code: outlet } }),
      ...(date && { shootDate: new Date(date) }),
      ...((from || to) && !date && { shootDate: { ...(from && { gte: new Date(from) }), ...(to && { lt: new Date(to) }) } }),
      // v1.144 — ?hasCode=1: only bookings with a Production ID. Filtering here
      // (not client-side after `take`) keeps null-code legacy rows from eating
      // result slots — a post-pagination filter made matches unreachable.
      ...(searchParams.get('hasCode') === '1' && { bookingCode: { not: null } }),
      ...(searchClause && { AND: [searchClause] }),
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

    // v1.111 — attach resolved crew names so cards can show "who's on the shoot".
    // One batched user query; SHORT names (team label / nickname / Thai first
    // name) — full legal names read terribly at card size (ops feedback).
    let outBookings: any[] = bookings
    if (withCrew) {
      const resolve = await makeCrewNameResolver(
        bookings
          .flatMap(b => [...((b as any).assignedEmails || []), (b as any).mainVideographerEmail])
          .filter((e): e is string => typeof e === 'string'),
      )
      // v1.111 — footage state for the cards' "ไฟล์ครบแล้ว" badge:
      //   footageFiles = files last detected in the booking's Drive folders,
      //   footageSent  = the NAS upload queue for this code fully drained.
      // v1.115 — producer nickname (real user record → clean the stored string).
      const producerNick = await makeProducerNickResolver(bookings.map(b => (b as any).producerEmail))
      const nasState = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } }).catch(() => null)
      const drained: Record<string, boolean> = {}
      const nasFolders = ((nasState?.status as any) || {}).folders || {}
      for (const [code, st] of Object.entries<any>(nasFolders)) drained[code] = !!st?.drainedAt
      outBookings = bookings.map(b => {
        const assigned: string[] = (b as any).assignedEmails || []
        const mainVdo = (b as any).mainVideographerEmail as string | null
        const cache = (b as any).footageCache as any
        return {
          ...b,
          footageCache: undefined, // don't ship the whole blob to the list
          assignedCrew: assigned.map(e => ({ email: e, name: resolve(e), isLead: !!mainVdo && e.toLowerCase() === mainVdo.toLowerCase() })),
          producerNick: producerNick((b as any).producerEmail) || shortPersonName(null, (b as any).producer, (b as any).producer) || (b as any).producer,
          footageFiles: typeof cache?.fileCount === 'number' ? cache.fileCount : null,
          footageSent: (b as any).bookingCode ? !!drained[(b as any).bookingCode] : false,
        }
      })
    }

    return NextResponse.json({ bookings: outBookings, total, page, limit })
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
