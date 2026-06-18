/**
 * Booking creation — extracted from POST /api/bookings (v1.49.0) so the
 * SAME validation + ID minting + audit + sheet sync serves both the web
 * form (session auth) and the MCP server (bearer auth). Behavior is a
 * 1:1 move of the route logic; the route keeps only auth + HTTP shaping.
 */
import { prisma } from '@/lib/db'
import { generateEpisodeId, formatShootDateForId } from '@/lib/episode-id'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { logAudit } from '@/lib/audit'

// Production ID middle segment, derived from the shoot type (e.g. AGN-260423-EVT-01).
const SHOOT_TYPE_CODE: Record<string, string> = {
  STUDIO: 'STD',
  ON_LOCATION: 'LOC',
  EVENT: 'EVT',
  REMOTE_ONLINE: 'REM',
}

export type CreateBookingResult =
  | { ok: true; booking: any }
  | { ok: false; status: number; error: string }

export async function createBookingFromPayload(
  body: any,
  actorEmail: string,
): Promise<CreateBookingResult> {
  const fail = (status: number, error: string): CreateBookingResult => ({ ok: false, status, error })

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
    coProducer,
    coProducerEmail,
    creative,
    crewRequired,
    videographerCount,
    cameraCount,
    micCount,
    needsVan,
    specialEquipment,
    agencyRef,
    projectId,
    projectName,
    notes,
    episodeTitles,
    episodes,
    selectedEpisodeIds,
    isRoutine,
    routineGroupId,
  } = body || {}

  // Validate outlet and program
  const outlet = getOutlet(outletCode)
  if (!outlet) return fail(400, `Unknown outlet: ${outletCode}`)
  const program = getProgram(outletCode, programCode)
  if (!program) return fail(400, `Unknown program: ${programCode} in ${outletCode}`)

  // Content Agency books a "Production" by SELECTING existing episodes; other
  // outlets enter titles and the app generates local Episode IDs.
  const isAgency = outletCode === 'AGN'
  // Normalized non-CA episode list: each episode carries its own program +
  // content type (v1.37). Populated/validated in the non-CA branch below.
  type EpisodeInput = { programCode: string; title: string; contentType: 'ORIGINAL_CONTENT' | 'ADVERTORIAL' }
  let episodeInputs: EpisodeInput[] = []
  if (isAgency) {
    if (!Array.isArray(selectedEpisodeIds) || selectedEpisodeIds.length === 0) {
      return fail(400, 'At least one episode must be selected')
    }
    if (selectedEpisodeIds.length > 20) return fail(400, 'Maximum 20 episodes per booking')
    if (!projectId) return fail(400, 'Project ID required for Content Agency')
  } else {
    // Prefer the structured `episodes` payload; fall back to the legacy flat
    // `episodeTitles` array (older clients) mapped onto the booking-level
    // program + category so nothing breaks mid-deploy.
    episodeInputs = Array.isArray(episodes) && episodes.length > 0
      ? (episodes as any[]).map(e => ({
          programCode: String(e?.programCode || programCode),
          title: String(e?.title ?? '').trim(),
          contentType: e?.contentType === 'ADVERTORIAL' ? 'ADVERTORIAL' : 'ORIGINAL_CONTENT',
        }))
      : (Array.isArray(episodeTitles) ? episodeTitles : []).map((t: any) => ({
          programCode,
          title: String(t ?? '').trim(),
          contentType: category === 'ADVERTORIAL' ? 'ADVERTORIAL' : 'ORIGINAL_CONTENT',
        }))
    if (episodeInputs.length === 0) return fail(400, 'At least one episode required')
    if (episodeInputs.length > 20) return fail(400, 'Maximum 20 episodes per booking')
    for (let i = 0; i < episodeInputs.length; i++) {
      const ep = episodeInputs[i]
      if (!ep.title) return fail(400, `Episode ${i + 1} title required`)
      if (!getProgram(outletCode, ep.programCode)) {
        return fail(400, `Unknown program: ${ep.programCode} in ${outletCode}`)
      }
    }
  }

  const parsedDate = new Date(shootDate)
  if (isNaN(parsedDate.getTime())) return fail(400, `Invalid shootDate: ${shootDate}`)

  // v1.66 — camera + mic counts are REQUIRED for every creation path (wizard,
  // routine generator, API/MCP). 0 is valid (audio-only / no-camera shoots) but
  // the count can't be missing — bookings without it broke the camera-overload
  // check and crew planning.
  const camNum = cameraCount === undefined || cameraCount === null || cameraCount === '' ? NaN : parseInt(cameraCount, 10)
  if (!Number.isInteger(camNum) || camNum < 0) return fail(400, 'cameraCount is required (use 0 for no camera)')
  const micNum = micCount === undefined || micCount === null || micCount === '' ? NaN : parseInt(micCount, 10)
  if (!Number.isInteger(micNum) || micNum < 0) return fail(400, 'micCount is required (use 0 for no mic)')

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
  type EpRecord = { episodeId: string; sequence: number; title: string; programId: string; contentType?: 'ORIGINAL_CONTENT' | 'ADVERTORIAL' }
  let episodeRecords: EpRecord[]
  let bookingCode: string

  if (isAgency) {
    const epList = await listProjectEpisodes(projectId)
    if (!epList.ok) {
      return fail(503, `โหลด episode ของ project ไม่ได้ (${epList.error}) — ลองใหม่อีกครั้ง`)
    }
    const byId = new Map(epList.episodes.map(e => [e.episodeId, e]))
    const chosen = (selectedEpisodeIds as string[])
      .map(id => byId.get(String(id).trim()))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
    if (chosen.length === 0) {
      return fail(400, 'Episode ที่เลือกถ่ายไม่ได้แล้ว (อาจถูก Published) — เลือกใหม่')
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
    // Episode ID carries the per-episode program code (v1.46.0 — ops
    // feedback: "รหัสรายการให้อยู่ใน Booking ID เช่น NWS-KYM-…"):
    //   [OUT]-[PROG]-[YYMMDD]-[EpisodeType]-[NN]  e.g. NWS-KYM-260616-L-01
    // sequenced per outlet+program+date+Episode-Type, so each show gets
    // its own numbering stream. Episodes in one booking may carry
    // different programs — each draws from its own stream.
    const dateStr = formatShootDateForId(parsedDate)

    // Upsert each distinct per-episode program once and cache its DB id.
    const programIdByCode = new Map<string, string>([[programCode, programDb.id]])
    const nextSeqByProgram = new Map<string, number>()
    episodeRecords = []
    for (let idx = 0; idx < episodeInputs.length; idx++) {
      const ep = episodeInputs[idx]
      let epProgramId = programIdByCode.get(ep.programCode)
      if (!epProgramId) {
        const epProgram = getProgram(outletCode, ep.programCode)!
        const epProgramDb = await prisma.program.upsert({
          where: { code_outletId: { code: ep.programCode, outletId: outletDb.id } },
          update: {},
          create: { code: epProgram.code, name: epProgram.name, category: epProgram.category, outletId: outletDb.id },
        })
        epProgramId = epProgramDb.id
        programIdByCode.set(ep.programCode, epProgramId)
      }

      // Program segment only when it's a real show code (2–4 alnum chars,
      // the strict-format constraint) and not just the Episode Type echoed
      // back by a legacy client — those keep the legacy ID shape.
      const epProgCode = ep.programCode.trim().toUpperCase()
      const progForId = /^[A-Z0-9]{2,4}$/.test(epProgCode) && epProgCode !== programCode
        ? epProgCode
        : null
      const streamKey = progForId ?? ''
      let nextSeq = nextSeqByProgram.get(streamKey)
      if (nextSeq === undefined) {
        const prefix = progForId
          ? `${outletCode}-${progForId}-${dateStr}-${programCode}-`
          : `${outletCode}-${dateStr}-${programCode}-`
        const lastEp = await prisma.episode.findFirst({
          where: { episodeId: { startsWith: prefix } },
          orderBy: { episodeId: 'desc' },
          select: { episodeId: true },
        })
        const lastNum = lastEp?.episodeId.match(/-(\d{2})$/)?.[1]
        nextSeq = (lastNum ? parseInt(lastNum, 10) : 0) + 1
      }
      nextSeqByProgram.set(streamKey, nextSeq + 1)

      episodeRecords.push({
        episodeId: generateEpisodeId(outletCode, parsedDate, programCode, nextSeq, progForId),
        sequence: nextSeq,
        title: ep.title,
        programId: epProgramId,
        contentType: ep.contentType,
      })
    }
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
      coProducer: coProducer || null,
      coProducerEmail: coProducerEmail || null,
      creative: creative || [],
      crewRequired: crewRequired || [],
      videographerCount: Math.max(1, Math.min(10, parseInt(videographerCount, 10) || 1)),
      cameraCount: cameraCount === undefined || cameraCount === null || cameraCount === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0),
      micCount: micCount === undefined || micCount === null || micCount === '' ? null : Math.max(0, parseInt(micCount, 10) || 0),
      needsVan: needsVan === true,
      specialEquipment: Array.isArray(specialEquipment) ? specialEquipment.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') : [],
      agencyRef: agencyRef || null,
      projectId: projectId || null,
      projectName: projectName || null,
      notes: notes || null,
      status: 'REQUESTED',
      isRoutine: isRoutine === true,
      routineGroupId: routineGroupId || null,
      createdByEmail: actorEmail,
      outletId: outletDb.id,
      programId: programDb.id,
      episodes: {
        create: episodeRecords,
      },
    },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
    },
  })

  // Audit — fire-and-forget, outside the booking transaction so an audit
  // failure can't bring down booking creation. logAudit swallows its own
  // errors and logs to console.
  logAudit({
    actorEmail,
    action: 'booking.create',
    entityType: 'Booking',
    entityId: booking.id,
    bookingCode: booking.bookingCode,
    toStatus: booking.status,
    changes: {
      episodeIds: booking.episodes.map((e: { episodeId: string }) => e.episodeId),
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

  return { ok: true, booking }
}
