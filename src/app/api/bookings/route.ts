import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateEpisodeId, formatShootDateForId } from '@/lib/episode-id'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { getSession } from '@/lib/session'
import { autoCompleteBookings } from '@/lib/booking-complete'
import { generateProjectEpisodeIds } from '@/lib/dashboard-episodes'
import { logAudit } from '@/lib/audit'

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
      videoType,
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
    if (episodeTitles.length > 20) {
      return NextResponse.json({ error: 'Maximum 20 episodes per booking' }, { status: 400 })
    }

    const parsedDate = new Date(shootDate)
    if (isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: `Invalid shootDate: ${shootDate}` }, { status: 400 })
    }

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
    //   Project-linked (projectId + episodeType): mint PP-YY-NNN-{type}NN IDs
    //   in-app and write them into the Producer Dashboard sheet (PD/Dir tabs)
    //   via the service account — numbered from the max in the producer's PD
    //   tab. If the sheet can't be reached/resolved we STOP with a clear error
    //   rather than mint an out-of-sequence ID.
    //   Otherwise (no project): a local [OUT]-[YYMMDD]-[PROG]-[NN] ID, numbered
    //   from the max existing episode for that outlet+date+program.
    let episodeIds: string[]
    let sequenceBase: number
    if (projectId && episodeType) {
      const result = await generateProjectEpisodeIds({
        projectId,
        type: episodeType,
        count: episodeTitles.length,
        titles: episodeTitles,
        productCode: agencyRef, // written to the PD tab "Product Code" column
      })
      if (!result.ok || result.episodeIds.length !== episodeTitles.length) {
        const reason = result.ok
          ? `got ${result.episodeIds.length}, expected ${episodeTitles.length}`
          : result.error
        return NextResponse.json(
          { error: `ออก Project ID ไม่ได้ตอนนี้ (Dashboard: ${reason}) — ลองใหม่อีกครั้ง` },
          { status: 503 },
        )
      }
      episodeIds = result.episodeIds
      sequenceBase = 1
    } else {
      const prefix = `${outletCode}-${formatShootDateForId(parsedDate)}-${programCode}-`
      const last = await prisma.episode.findFirst({
        where: { episodeId: { startsWith: prefix } },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      sequenceBase = (last?.sequence ?? 0) + 1
      episodeIds = episodeTitles.map((_: string, idx: number) =>
        generateEpisodeId(outletCode, parsedDate, programCode, sequenceBase + idx),
      )
    }

    // Create booking + its episodes. A nested create is atomic on its own —
    // no explicit transaction needed.
    const booking = await prisma.booking.create({
      data: {
        // bookingCode = first episode's ID: same format as Episode.episodeId,
        // unique, and a readable handle for the whole booking.
        bookingCode: episodeIds[0],
        shootDate: parsedDate,
        shootEndDate: shootEndDate ? new Date(shootEndDate) : null,
        category,
        videoType: videoType || null,
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

    // Audit — fire-and-forget, outside the booking transaction so an audit
    // failure can't bring down booking creation. logAudit swallows its own
    // errors and logs to console.
    logAudit({
      actorEmail: session.email,
      action: 'booking.create',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      toStatus: booking.status,
      changes: {
        episodeIds: booking.episodes.map(e => e.episodeId),
        outletCode,
        programCode,
        shootDate: parsedDate.toISOString(),
      },
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
