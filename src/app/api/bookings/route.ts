import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateEpisodeId } from '@/lib/episode-id'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { getSession } from '@/lib/session'
import { autoCompleteBookings } from '@/lib/booking-complete'
import { requestEpisodeIds, type EpisodeType } from '@/lib/booking-episode-api'

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
    const scope = searchParams.get('scope') // 'mine' | 'all'

    // Non-admins always restricted to their own bookings + confirmed bookings
    const userFilter = session.role === 'ADMIN' && scope !== 'mine'
      ? {}
      : {
          OR: [
            { createdByEmail: session.email },
            { assignedEmails: { has: session.email } },
            ...(scope === 'mine' ? [] : [{ status: 'CONFIRMED' as const }]),
          ],
        }

    const where = {
      ...userFilter,
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
          episodes: { orderBy: { sequence: 'asc' } },
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
    const {
      outletCode,
      programCode,
      shootDate,
      shootEndDate,
      category,
      shootType,
      locationName,
      callTime,
      estimatedWrap,
      producer,
      producerEmail,
      producerPhone,
      director,
      directorEmail,
      creative,
      crewRequired,
      videographerCount,
      agencyRef,
      projectId,
      projectName,
      episodeType,
      notes,
      episodeTitles,
    } = body

    // Validate outlet and program
    const outlet = getOutlet(outletCode)
    if (!outlet) {
      return NextResponse.json({ error: `Unknown outlet: ${outletCode}` }, { status: 400 })
    }
    const program = getProgram(outletCode, programCode)
    if (!program) {
      return NextResponse.json({ error: `Unknown program: ${programCode} in ${outletCode}` }, { status: 400 })
    }

    if (!episodeTitles || episodeTitles.length === 0) {
      return NextResponse.json({ error: 'At least one episode title required' }, { status: 400 })
    }

    const parsedDate = new Date(shootDate)

    // Upsert outlet DB record
    const outletDb = await prisma.outlet.upsert({
      where: { code: outletCode },
      update: {},
      create: { code: outlet.code, name: outlet.name, notes: outlet.description, sort: outlet.sort },
    })

    // Upsert program DB record
    const programDb = await prisma.program.upsert({
      where: { code_outletId: { code: programCode, outletId: outletDb.id } },
      update: {},
      create: { code: program.code, name: program.name, category: program.category, outletId: outletDb.id },
    })

    // Determine Episode IDs.
    //   Project-linked (projectId + episodeType): ask the Producer Dashboard's
    //     Apps Script Web App for sheet-generated PP-YY-NNN-{type}NN IDs. The
    //     Web App is the single owner of the EP_SEQ_ counter — so bookings
    //     and hand-typed episodes stay in one continuous sequence.
    //   Otherwise: generate locally with [OUT]-[YYMMDD]-[PROG]-[EE].
    let episodeIds: string[]
    let sequenceBase: number
    if (projectId && episodeType) {
      const result = await requestEpisodeIds({
        projectId,
        type: episodeType as EpisodeType,
        count: episodeTitles.length,
        titles: episodeTitles,
      })
      if (!result.ok) {
        return NextResponse.json(
          { error: `Failed to get Episode IDs from the Dashboard: ${result.error}` },
          { status: 502 },
        )
      }
      if (result.episodeIds.length !== episodeTitles.length) {
        return NextResponse.json(
          { error: `Dashboard returned ${result.episodeIds.length} IDs, expected ${episodeTitles.length}` },
          { status: 502 },
        )
      }
      episodeIds = result.episodeIds
      sequenceBase = 1
    } else {
      // Find next available sequence for this outlet+program+date
      const existingEpisodes = await prisma.episode.findMany({
        where: {
          episodeId: {
            startsWith: `${outletCode}-${formatDateForId(parsedDate)}-${programCode}-`,
          },
        },
        orderBy: { sequence: 'desc' },
        take: 1,
      })
      const startSeq = existingEpisodes.length > 0 ? existingEpisodes[0].sequence + 1 : 1
      episodeIds = episodeTitles.map((_: string, idx: number) =>
        generateEpisodeId(outletCode, parsedDate, programCode, startSeq + idx),
      )
      sequenceBase = startSeq
    }

    // Create booking + episodes in a transaction
    const booking = await prisma.$transaction(async (tx) => {
      const newBooking = await tx.booking.create({
        data: {
          shootDate: parsedDate,
          shootEndDate: shootEndDate ? new Date(shootEndDate) : null,
          category,
          shootType,
          locationName: locationName || null,
          callTime,
          estimatedWrap: estimatedWrap || null,
          producer,
          producerEmail: producerEmail || null,
          producerPhone: producerPhone || null,
          director: director || null,
          directorEmail: directorEmail || null,
          creative: creative || [],
          crewRequired: crewRequired || [],
          videographerCount: Math.max(1, Math.min(10, parseInt(videographerCount, 10) || 1)),
          agencyRef: agencyRef || null,
          projectId: projectId || null,
          projectName: projectName || null,
          notes: notes || null,
          status: 'REQUESTED',
          createdByEmail: session.email,
          outletId: outletDb.id,
          programId: programDb.id,
          episodes: {
            create: episodeTitles.map((title: string, idx: number) => ({
              episodeId: episodeIds[idx],
              sequence: sequenceBase + idx,
              title,
              programId: programDb.id,
            })),
          },
        },
        include: {
          outlet: true,
          program: true,
          episodes: { orderBy: { sequence: 'asc' } },
        },
      })
      return newBooking
    })

    // Sync to the Producer Dashboard "Bookings" tab — Content Agency only.
    // Other outlets are recorded in the DB but not pushed to any sheet, so
    // they never get a sheetRowIndex and later updateBookingRow calls no-op.
    if (outletCode === 'AGN') {
      appendBookingRow({
        ...booking,
        shootDate: booking.shootDate,
        createdAt: booking.createdAt,
      }).then(rowIndex => {
        if (rowIndex) {
          prisma.booking.update({ where: { id: booking.id }, data: { sheetRowIndex: rowIndex } }).catch(() => {})
        }
      }).catch(() => {})
    }

    return NextResponse.json({ booking }, { status: 201 })
  } catch (error) {
    console.error('POST /api/bookings error:', error)
    return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 })
  }
}

function formatDateForId(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
