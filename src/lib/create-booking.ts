/**
 * Booking creation — extracted from POST /api/bookings (v1.49.0) so the
 * SAME validation + ID minting + audit + sheet sync serves both the web
 * form (session auth) and the MCP server (bearer auth). Behavior is a
 * 1:1 move of the route logic; the route keeps only auth + HTTP shaping.
 */
import { prisma } from '@/lib/db'
import { generateEpisodeId, parseEpisodeId, formatShootDateForId } from '@/lib/episode-id'
import { normalizeBuddhistYear } from '@/lib/thai-date'
import { getOutlet, getProgram } from '@/lib/data'
import { appendBookingRow } from '@/lib/google-sheets'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { logAudit } from '@/lib/audit'
import { deriveBookingCategory } from '@/lib/booking-category'
import { isValidHHMM } from '@/lib/shoot-window'

export type CreateBookingResult =
  | { ok: true; booking: any }
  | { ok: false; status: number; error: string }

export async function createBookingFromPayload(
  body: any,
  actorEmail: string,
  // v1.146 review fix — the MCP path used to fold "requested by" into the
  // actor string ("mcp@… (for jane@…)"), which was then stored VERBATIM as
  // Booking.createdByEmail — breaking every owner check (self-cancel,
  // self-edit, canViewBooking) and the approve confirmation email for
  // MCP-created bookings. Callers now pass a VERIFIED createdByEmail
  // separately (defaults to actorEmail) and the raw requestedBy note goes
  // into the audit trail instead of the identity column.
  opts: { createdByEmail?: string | null; requestedBy?: string | null } = {},
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
    switcherCount,
    cameraCount,
    micCount,
    isBlockShot,
    vanCount,
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

  const rawDate = new Date(shootDate)
  if (isNaN(rawDate.getTime())) return fail(400, `Invalid shootDate: ${shootDate}`)
  // Guard: a Buddhist-era year (พ.ศ. ≥ 2500, e.g. a migration pasting 2569 for 2026)
  // would corrupt both the displayed date AND the Production ID (derived below).
  // Normalize to Gregorian. Wizard <input type="date"> is always Gregorian.
  // Shared with the edit path via normalizeBuddhistYear (src/lib/thai-date.ts).
  const parsedDate = normalizeBuddhistYear(rawDate)!
  const parsedEnd = normalizeBuddhistYear(shootEndDate ? new Date(shootEndDate) : null) ?? null

  // v1.146 review fix — callTime/estimatedWrap must be zero-padded 24h HH:MM.
  // The wizard's <input type=time> guarantees it, but this shared path also
  // serves the MCP server / raw API, where "9:00" or "09:00 AM" used to be
  // written straight to the DB and silently broke every string-compare
  // downstream (isShootOver, camera-overlap, Week Plan).
  if (!isValidHHMM(callTime)) {
    return fail(400, `Invalid callTime "${callTime}" — must be 24h HH:MM, zero-padded (e.g. 09:00)`)
  }
  if (estimatedWrap != null && estimatedWrap !== '' && !isValidHHMM(estimatedWrap)) {
    return fail(400, `Invalid estimatedWrap "${estimatedWrap}" — must be 24h HH:MM, zero-padded (e.g. 18:00)`)
  }

  // v1.66 — camera + mic counts are REQUIRED for every creation path (wizard,
  // routine generator, API/MCP). 0 is valid (audio-only / no-camera shoots) but
  // the count can't be missing — bookings without it broke the camera-overload
  // check and crew planning.
  // v1.67 — Block Shot bookings are exempt (gear isn't pinned down at booking).
  const blockShot = isBlockShot === true || isBlockShot === 'true' || isBlockShot === 1
  if (!blockShot) {
    const camNum = cameraCount === undefined || cameraCount === null || cameraCount === '' ? NaN : parseInt(cameraCount, 10)
    if (!Number.isInteger(camNum) || camNum < 0) return fail(400, 'cameraCount is required (use 0 for no camera) unless isBlockShot')
    const micNum = micCount === undefined || micCount === null || micCount === '' ? NaN : parseInt(micCount, 10)
    if (!Number.isInteger(micNum) || micNum < 0) return fail(400, 'micCount is required (use 0 for no mic) unless isBlockShot')
  }

  // v1.146 review fix — two FIRST-EVER bookings for an outlet/program racing
  // each other can both take the upsert's create path and the loser throws
  // P2002 (observed in live concurrency testing; e.g. a brand-new program's
  // first day with two producers booking simultaneously). The loser simply
  // re-reads the row the winner just created.
  const upsertIgnoreRace = async <T>(upsert: () => Promise<T>, reread: () => Promise<T | null>): Promise<T> => {
    try { return await upsert() } catch (e: any) {
      if (e?.code === 'P2002') { const row = await reread(); if (row) return row }
      throw e
    }
  }

  // Upsert outlet DB record
  const outletDb = await upsertIgnoreRace(
    () => prisma.outlet.upsert({
      where: { code: outletCode },
      update: {},
      create: { code: outlet.code, name: outlet.name, notes: outlet.description, sort: outlet.sort },
    }),
    () => prisma.outlet.findUnique({ where: { code: outletCode } }),
  )

  // Upsert program DB record
  const programDb = await upsertIgnoreRace(
    () => prisma.program.upsert({
      where: { code_outletId: { code: programCode, outletId: outletDb.id } },
      update: {},
      create: { code: program.code, name: program.name, category: program.category, outletId: outletDb.id },
    }),
    () => prisma.program.findUnique({ where: { code_outletId: { code: programCode, outletId: outletDb.id } } }),
  )

  // Build the booking's episode rows + its code.
  //   Content Agency: the booking is a Production (a shoot). The user picked
  //   EXISTING episodes of the project; we re-fetch them server-side (source
  //   of truth, also drops any that got Published since), mint a Production ID
  //   (OUT-YYMMDD-SHOOTTYPE-NN) as the booking code, and attach the chosen
  //   episodes — we do NOT generate new Episode IDs.
  type EpRecord = { episodeId: string; sequence: number; title: string; programId: string; contentType?: 'ORIGINAL_CONTENT' | 'ADVERTORIAL' }

  // AGN: fetch + validate the chosen project episodes BEFORE the locked
  // transaction below — an external sheet read must never run while holding
  // the sequence lock.
  let agnChosen: Array<{ episodeId: string; ep: string | null; projectName: string }> | null = null
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
    agnChosen = chosen
  }

  // Non-AGN: upsert each distinct per-episode program once BEFORE the locked
  // transaction (idempotent), so the locked section only does sequence reads
  // + the create.
  const programIdByCode = new Map<string, string>([[programCode, programDb.id]])
  if (!isAgency) {
    for (const ep of episodeInputs) {
      if (programIdByCode.has(ep.programCode)) continue
      const epProgram = getProgram(outletCode, ep.programCode)!
      const epProgramDb = await upsertIgnoreRace(
        () => prisma.program.upsert({
          where: { code_outletId: { code: ep.programCode, outletId: outletDb.id } },
          update: {},
          create: { code: epProgram.code, name: epProgram.name, category: epProgram.category, outletId: outletDb.id },
        }),
        () => prisma.program.findUnique({ where: { code_outletId: { code: ep.programCode, outletId: outletDb.id } } }),
      )
      programIdByCode.set(ep.programCode, epProgramDb.id)
    }
  }

  // booking.category — v1.98.0: derived from per-episode contentType for non-AGN
  // (radio removed), explicit for AGN (drives folder routing). See booking-category.ts.
  const bookingCategory = deriveBookingCategory(isAgency, category, episodeInputs)

  const dateStr = formatShootDateForId(parsedDate)
  // v1.146 review fix — sequence allocation used to be a plain read-then-create
  // (findMany → reduce → create) with no lock: two bookings submitted at the
  // same moment for the same outlet+date could compute the same next sequence
  // and either fail on the @unique bookingCode (first episode) or silently
  // share an Episode ID (episodeId is deliberately NOT unique). A Postgres
  // advisory transaction lock keyed per outlet+date serializes the compute +
  // create; the lock releases automatically at commit/rollback.
  const seqLockKey = `booking-seq:${outletCode}:${dateStr}`

  // Create booking + its episodes inside the locked transaction.
  const booking = await prisma.$transaction(async (tx) => {
    // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, which
    // $queryRaw fails to deserialize — caught in live DB testing.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${seqLockKey}))`

    let episodeRecords: EpRecord[]
    let bookingCode: string
    if (isAgency) {
      // Production ID = OUT-YYMMDD-NN, numbered per outlet+date (v1.109: [TYPE] dropped).
      // Prefix matches both new (OUT-YYMMDD-NN) and any legacy (OUT-YYMMDD-TYPE-NN) IDs
      // for this outlet+date, so the sequence never reuses a number across the migration.
      const codePrefix = `${outletCode}-${dateStr}-`
      const priorBk = await tx.booking.findMany({
        where: { bookingCode: { startsWith: codePrefix } },
        select: { bookingCode: true },
      })
      const seq = priorBk.reduce((mx, b) => {
        const p = b.bookingCode ? parseEpisodeId(b.bookingCode) : null
        return p && p.sequence > mx ? p.sequence : mx
      }, 0) + 1
      bookingCode = generateEpisodeId(outletCode, parsedDate, seq) // AGN-260423-01
      episodeRecords = agnChosen!.map((e, idx) => ({
        episodeId: e.episodeId,
        sequence: idx + 1,
        title: e.ep && e.ep !== '-' ? e.ep : e.projectName,
        programId: programDb.id,
      }))
    } else {
      // Episode ID carries the per-episode program code (v1.46.0 — ops
      // feedback: "รหัสรายการให้อยู่ใน Booking ID เช่น NWS-KYM-…"):
      //   [OUT]-[PROG]-[YYMMDD]-[NN]  e.g. NWS-KYM-260616-01  (v1.109: [TYPE] dropped)
      // sequenced per outlet+program+date, so each show gets its own numbering
      // stream. Episodes in one booking may carry different programs — each draws
      // from its own stream.
      const nextSeqByProgram = new Map<string, number>()
      episodeRecords = []
      for (let idx = 0; idx < episodeInputs.length; idx++) {
        const ep = episodeInputs[idx]
        const epProgramId = programIdByCode.get(ep.programCode)!

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
          // v1.109 — sequence is per outlet+program+date (the [TYPE] segment is gone).
          // Prefix matches both new (…-date-NN) and legacy (…-date-TYPE-NN) IDs so the
          // number never collides across the migration.
          const prefix = progForId
            ? `${outletCode}-${progForId}-${dateStr}-`
            : `${outletCode}-${dateStr}-`
          const prior = await tx.episode.findMany({
            where: { episodeId: { startsWith: prefix } },
            select: { episodeId: true },
          })
          nextSeq = prior.reduce((mx, e) => {
            const p = parseEpisodeId(e.episodeId)
            return p && p.sequence > mx ? p.sequence : mx
          }, 0) + 1
        }
        nextSeqByProgram.set(streamKey, nextSeq + 1)

        episodeRecords.push({
          episodeId: generateEpisodeId(outletCode, parsedDate, nextSeq, progForId),
          sequence: nextSeq,
          title: ep.title,
          programId: epProgramId,
          contentType: ep.contentType,
        })
      }
      bookingCode = episodeRecords[0].episodeId
    }

    return tx.booking.create({
      data: {
      // bookingCode = the booking's handle: a Production ID (Content Agency)
      // or the first local Episode ID (other outlets).
      bookingCode,
      shootDate: parsedDate,
      shootEndDate: parsedEnd,
      category: bookingCategory,
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
      creative: creative || [],
      crewRequired: crewRequired || [],
      videographerCount: Math.max(1, Math.min(10, parseInt(videographerCount, 10) || 1)),
      switcherCount: Math.max(1, Math.min(10, parseInt(switcherCount, 10) || 1)),
      cameraCount: cameraCount === undefined || cameraCount === null || cameraCount === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0),
      micCount: micCount === undefined || micCount === null || micCount === '' ? null : Math.max(0, parseInt(micCount, 10) || 0),
      isBlockShot: blockShot,
      vanCount: Math.max(0, Math.min(20, parseInt(vanCount, 10) || 0)),
      specialEquipment: Array.isArray(specialEquipment) ? specialEquipment.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') : [],
      agencyRef: agencyRef || null,
      projectId: projectId || null,
      projectName: projectName || null,
      notes: notes || null,
      status: 'REQUESTED',
      isRoutine: isRoutine === true,
      routineGroupId: routineGroupId || null,
      createdByEmail: opts.createdByEmail || actorEmail,
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
  }, { timeout: 15000 }) // headroom for lock wait when two creates contend

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
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
      ...(opts.createdByEmail && opts.createdByEmail !== actorEmail ? { createdByEmail: opts.createdByEmail } : {}),
    },
  })

  // Sync to the Producer Dashboard "Bookings" tab — ALL outlets (v1.148.0).
  // Historically AGN-only; PMDC's Airtable sync now consumes every outlet's
  // bookings (Production ID spine → Service Job → footage mapping), so every
  // booking gets a row. Row lifecycle (approve/assign/cancel patches) is
  // already outlet-agnostic — it keys on sheetRowIndex + col-A Production ID.
  // Kill-switch: set BOOKINGS_EXPORT_AGN_ONLY=1 to restore the old behavior.
  const agnOnlyExport = process.env.BOOKINGS_EXPORT_AGN_ONLY === '1'
  if (!agnOnlyExport || outletCode === 'AGN') {
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
