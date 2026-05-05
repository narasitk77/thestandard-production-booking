import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateEpisodeId } from '@/lib/episode-id'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { getSession } from '@/lib/session'
import { autoCompleteBookings } from '@/lib/booking-complete'

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
      creative,
      crewRequired,
      agencyRef,
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
          creative: creative || [],
          crewRequired: crewRequired || [],
          agencyRef: agencyRef || null,
          notes: notes || null,
          status: 'REQUESTED',
          createdByEmail: session.email,
          outletId: outletDb.id,
          programId: programDb.id,
          episodes: {
            create: episodeTitles.map((title: string, idx: number) => ({
              episodeId: generateEpisodeId(outletCode, parsedDate, programCode, startSeq + idx),
              sequence: startSeq + idx,
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

    // Write to Google Sheets (non-blocking)
    appendBookingRow({
      ...booking,
      shootDate: booking.shootDate,
      createdAt: booking.createdAt,
    }).then(rowIndex => {
      if (rowIndex) {
        prisma.booking.update({ where: { id: booking.id }, data: { sheetRowIndex: rowIndex } }).catch(() => {})
      }
    }).catch(() => {})

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
