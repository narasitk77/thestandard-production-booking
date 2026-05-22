import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateEpisodeId, formatShootDateForId } from '@/lib/episode-id'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { getSession } from '@/lib/session'
import { autoCompleteBookings } from '@/lib/booking-complete'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { logAudit } from '@/lib/audit'

// Production ID middle segment, derived from the shoot type (e.g. AGN-260423-EVT-01).
const SHOOT_TYPE_CODE: Record<string, string> = {
  STUDIO: 'STD',
  ON_LOCATION: 'LOC',
  EVENT: 'EVT',
  REMOTE_ONLINE: 'REM',
}

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

    // scope=producer → only shoots where this user is the Producer (their own
    // email — safe, no leak). Otherwise non-admins are restricted to their own
    // bookings + confirmed bookings; admins (no scope) see everything.
    const userFilter = scope === 'producer'
      ? { producerEmail: session.email }
      : session.role === 'ADMIN' && scope !== 'mine'
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
      selectedEpisodeIds,
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

    // Content Agency books a "Production" by SELECTING existing episodes; other
    // outlets enter titles and the app generates local Episode IDs.
    const isAgency = outletCode === 'AGN'
    if (isAgency) {
      if (!Array.isArray(selectedEpisodeIds) || selectedEpisodeIds.length === 0) {
        return NextResponse.json({ error: 'At least one episode must be selected' }, { status: 400 })
      }
      if (selectedEpisodeIds.length > 20) {
        return NextResponse.json({ error: 'Maximum 20 episodes per booking' }, { status: 400 })
      }
      if (!projectId) {
        return NextResponse.json({ error: 'Project ID required for Content Agency' }, { status: 400 })
      }
    } else {
      if (!episodeTitles || episodeTitles.length === 0) {
        return NextResponse.json({ error: 'At least one episode title required' }, { status: 400 })
      }
      if (episodeTitles.length > 20) {
        return NextResponse.json({ error: 'Maximum 20 episodes per booking' }, { status: 400 })
      }
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

    // Build the booking's episode rows + its code.
    //   Content Agency: the booking is a Production (a shoot). The user picked
    //   EXISTING episodes of the project; we re-fetch them server-side (source
    //   of truth, also drops any that got Published since), mint a Production ID
    //   (OUT-YYMMDD-SHOOTTYPE-NN) as the booking code, and attach the chosen
    //   episodes — we do NOT generate new Episode IDs.
    //   Other outlets: legacy — generate local [OUT]-[YYMMDD]-[PROG]-[NN] IDs
    //   from the entered titles; bookingCode = first episode.
    type EpRecord = { episodeId: string; sequence: number; title: string; programId: string }
    let episodeRecords: EpRecord[]
    let bookingCode: string

    if (isAgency) {
      const epList = await listProjectEpisodes(projectId)
      if (!epList.ok) {
        return NextResponse.json(
          { error: `โหลด episode ของ project ไม่ได้ (${epList.error}) — ลองใหม่อีกครั้ง` },
          { status: 503 },
        )
      }
      const byId = new Map(epList.episodes.map(e => [e.episodeId, e]))
      const chosen = (selectedEpisodeIds as string[])
        .map(id => byId.get(String(id).trim()))
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
      if (chosen.length === 0) {
        return NextResponse.json(
          { error: 'Episode ที่เลือกถ่ายไม่ได้แล้ว (อาจถูก Published) — เลือกใหม่' },
          { status: 400 },
        )
      }
      // Production ID = OUT-YYMMDD-SHOOTTYPE-NN, numbered per outlet+date+type.
      const shootCode = SHOOT_TYPE_CODE[shootType as string] || 'GEN'
      const codePrefix = `${outletCode}-${formatShootDateForId(parsedDate)}-${shootCode}-`
      const lastBk = await prisma.booking.findFirst({
        where: { bookingCode: { startsWith: codePrefix } },
        orderBy: { bookingCode: 'desc' },
        select: { bookingCode: true },
      })
      const lastSeq = lastBk?.bookingCode?.match(/-(\d+)$/)?.[1]
      const seq = (lastSeq ? parseInt(lastSeq, 10) : 0) + 1
      bookingCode = generateEpisodeId(outletCode, parsedDate, shootCode, seq) // AGN-260423-EVT-01
      episodeRecords = chosen.map((e, idx) => ({
        episodeId: e.episodeId,
        sequence: idx + 1,
        title: e.ep && e.ep !== '-' ? e.ep : e.projectName,
        programId: programDb.id,
      }))
    } else {
      const prefix = `${outletCode}-${formatShootDateForId(parsedDate)}-${programCode}-`
      const last = await prisma.episode.findFirst({
        where: { episodeId: { startsWith: prefix } },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      const startSeq = (last?.sequence ?? 0) + 1
      episodeRecords = (episodeTitles as string[]).map((title, idx) => ({
        episodeId: generateEpisodeId(outletCode, parsedDate, programCode, startSeq + idx),
        sequence: startSeq + idx,
        title,
        programId: programDb.id,
      }))
      bookingCode = episodeRecords[0].episodeId
    }

    // Create booking + its episodes. A nested create is atomic on its own.
    const booking = await prisma.booking.create({
      data: {
        // bookingCode = the booking's handle: a Production ID (Content Agency)
        // or the first local Episode ID (other outlets).
        bookingCode,
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
          create: episodeRecords,
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
