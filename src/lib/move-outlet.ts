/**
 * ย้ายสังกัด (cross-outlet move) — v1.163.
 *
 * A booking filed under the wrong outlet used to be unfixable: outlet is baked
 * into the Production ID, the Drive path, the sheet, the calendar title and the
 * _SHOOT marker, and `planReprogram` (v1.109) only moves an episode between
 * shows WITHIN one outlet. Ops' only workaround was to cancel and re-book,
 * which loses the ID, the folder and the crew's calendar invites.
 *
 * This module computes the plan; `regenerateBookingId` (still the ONE place an
 * ID changes) executes it. The split matters: everything here is either pure or
 * read-only + additive upserts, so a refusal or a crash mid-plan leaves nothing
 * to undo.
 *
 * THE INVARIANT THAT MAKES IT SAFE: the Drive box keeps its **id**. Both outlets
 * live in the same shared drive, so the move is an intra-drive reparent, never a
 * copy — every file inside, every pasted folder URL, `_SHOOT.txt`, and the
 * sheet's Drive-box-id column stay valid. We never create a replacement box.
 *
 * WHAT IS DELIBERATELY REFUSED (see `validateOutletMove`) — each of these would
 * need its own migration, and half-doing one is worse than not offering it:
 * AGN either side (project-keyed box + PP- episode IDs), photo albums (different
 * shared drive), project-linked bookings (box shared with sibling คิว), and
 * anything already delivered (the external footage log quotes the old ID).
 */
import { prisma } from './db'
import { getOutlet, getProgram } from './data'
import { parseEpisodeId, generateEpisodeId, formatShootDateForId } from './episode-id'
import {
  outletDriveFolderName,
  shootFolderLayers,
  isPhotoAlbumBooking,
  folderNameMatchesCode,
} from './outlet-folders'
import { getDriveLink } from './drive-links'
import type { EpisodeIdChange } from './id-migration'

export function moveOutletEnabled(): boolean {
  return process.env.MOVE_OUTLET_ENABLED?.trim() !== '0'
}

// ── pure core ────────────────────────────────────────────────────────────────

/**
 * The program-segment rule, byte-identical to create-booking.ts and
 * reprogram-booking.ts:96 — a show code is included in the ID only when it is a
 * real 2–4 char code AND differs from the booking-level Episode Type. Extracted
 * so a test pins the three implementations together.
 */
export function progSegmentForId(code: string, bookingProgCode: string): string | null {
  const c = (code || '').trim().toUpperCase()
  return /^[A-Z0-9]{2,4}$/.test(c) && c !== (bookingProgCode || '').trim().toUpperCase() ? c : null
}

/**
 * The predicate `samePlace` should always have been: a booking box is in the
 * right place only when BOTH its outlet layer and its program layer match.
 * The v1.109 code compared the program folder alone, so a cross-outlet move
 * whose show name happened to be unchanged would silently skip the relocation.
 */
export function boxNeedsRelocation(
  a: { outletCanon: string; programFolder: string },
  b: { outletCanon: string; programFolder: string },
): boolean {
  return a.outletCanon !== b.outletCanon || a.programFolder !== b.programFolder
}

/**
 * id-first name guard. Accepts the NEW code as well as the old one: if an
 * earlier attempt already moved+renamed the box but died before the DB commit,
 * the retry must recognise its own work instead of falling through to
 * "not found" and refusing forever.
 */
export function boxNameAcceptable(name: string, oldCode: string, newCode: string): boolean {
  return folderNameMatchesCode(name, oldCode) || folderNameMatchesCode(name, newCode)
}

/**
 * Recompute every episode ID against the TARGET outlet. Mirrors
 * reprogram-booking.ts's sequence draw, with two differences: the target outlet
 * is used on every axis, and EVERY episode changes (the outlet segment always
 * differs), so the caller gets a complete change set.
 *
 * `priorByPrefix` is the caller's read of the target streams; the moving
 * episodes are excluded so they can never inflate their own sequence.
 */
export function computeOutletMoveIds(input: {
  targetOutletCode: string
  targetBookingProgramCode: string
  shootDate: Date
  episodes: Array<{ id: string; episodeId: string; targetProgramCode: string }>
  priorByPrefix: Record<string, Array<{ id: string; episodeId: string }>>
  movingEpisodeDbIds: Set<string>
}): { newBookingCode: string; episodeChanges: EpisodeIdChange[] } {
  const { targetOutletCode, targetBookingProgramCode, shootDate, episodes } = input
  const dateStr = formatShootDateForId(shootDate)
  const nextSeqByStream = new Map<string, number>()
  const episodeChanges: EpisodeIdChange[] = []

  for (const ep of episodes) {
    const progForId = progSegmentForId(ep.targetProgramCode, targetBookingProgramCode)
    const prefix = progForId
      ? `${targetOutletCode}-${progForId}-${dateStr}-`
      : `${targetOutletCode}-${dateStr}-`

    let nextSeq = nextSeqByStream.get(prefix)
    if (nextSeq === undefined) {
      nextSeq = (input.priorByPrefix[prefix] || []).reduce((mx, e) => {
        if (input.movingEpisodeDbIds.has(e.id)) return mx
        const p = parseEpisodeId(e.episodeId)
        return p && p.sequence > mx ? p.sequence : mx
      }, 0) + 1
    }
    nextSeqByStream.set(prefix, nextSeq + 1)

    const newEpisodeId = generateEpisodeId(targetOutletCode, shootDate, nextSeq, progForId)
    if (newEpisodeId !== ep.episodeId) {
      episodeChanges.push({ episodeDbId: ep.id, oldEpisodeId: ep.episodeId, newEpisodeId })
    }
  }

  const first = episodes[0]
  const firstChange = episodeChanges.find(c => c.episodeDbId === first?.id)
  return { newBookingCode: firstChange?.newEpisodeId || first?.episodeId || '', episodeChanges }
}

/** The stream prefixes `computeOutletMoveIds` will read — so the caller knows
 *  exactly which `episodeId startsWith` queries to run, and preview and apply
 *  can never scan different streams. */
export function moveStreamPrefixes(input: {
  targetOutletCode: string
  targetBookingProgramCode: string
  shootDate: Date
  targetProgramCodes: string[]
}): string[] {
  const dateStr = formatShootDateForId(input.shootDate)
  const out = new Set<string>()
  for (const code of input.targetProgramCodes) {
    const seg = progSegmentForId(code, input.targetBookingProgramCode)
    out.add(seg
      ? `${input.targetOutletCode}-${seg}-${dateStr}-`
      : `${input.targetOutletCode}-${dateStr}-`)
  }
  return Array.from(out)
}

// ── validation ───────────────────────────────────────────────────────────────

export type ValidateInput = {
  bookingCode: string | null
  deletedAt: Date | null
  status: string
  deliveredAt: Date | null
  projectId: string | null
  outletCode: string
  program: { code: string } | null
  episodes: Array<{ id: string; episodeId: string; program: { code: string } | null }>
}

/**
 * Every refusal, in order, in Thai, all decided before a single byte is written.
 * Pure — takes a booking-shaped object so tests can drive it without Prisma.
 */
export function validateOutletMove(
  b: ValidateInput,
  targetOutletCode: string,
  programByEpisodeDbId: Record<string, string>,
): { ok: true; resolved: Array<{ id: string; code: string }> } | { ok: false; error: string } {
  const target = (targetOutletCode || '').trim().toUpperCase()
  const src = (b.outletCode || '').trim().toUpperCase()

  if (!b.bookingCode) return { ok: false, error: 'booking นี้ยังไม่มีเลข Production ID — ย้ายไม่ได้' }
  if (b.deletedAt) return { ok: false, error: 'booking ถูกลบอยู่ — กู้คืนก่อนจึงจะย้ายได้' }
  if (src === 'AGN' || target === 'AGN') {
    return { ok: false, error: 'Content Agency ใช้กล่อง Drive ของ project และ Episode ID แบบ PP- — ย้ายเข้า/ออกไม่รองรับ' }
  }
  const targetOutlet = getOutlet(target)
  if (!targetOutlet) return { ok: false, error: `ไม่รู้จักสังกัด "${targetOutletCode}"` }
  if (target === src) {
    return { ok: false, error: 'สังกัดเดิม — ถ้าจะเปลี่ยนแค่รายการ ให้ใช้ปุ่ม "แก้รายการ"' }
  }
  if (b.projectId) {
    return { ok: false, error: `booking นี้ผูกกับ project (${b.projectId}) — กล่อง Drive ใช้ร่วมกับคิวอื่น ย้ายไม่ได้` }
  }
  if (isPhotoAlbumBooking(b.episodes)) {
    return { ok: false, error: 'งาน Photo album (รายการ A) เก็บคนละไดรฟ์ — ย้ายไม่รองรับ' }
  }
  if (b.status === 'COMPLETED' || b.deliveredAt) {
    return { ok: false, error: 'booking นี้ส่งงานแล้ว — footage log ภายนอกอ้างเลข ID เดิมไว้ แก้ย้อนหลังไม่ได้' }
  }
  if (!b.program) return { ok: false, error: 'booking ไม่มี Episode Type — ย้ายไม่ได้' }
  if (!getProgram(target, b.program.code)) {
    return { ok: false, error: `สังกัด ${target} ไม่มี Episode Type "${b.program.code}"` }
  }
  if (b.episodes.length === 0) return { ok: false, error: 'booking ไม่มี episode — ย้ายไม่ได้' }

  // Auto-carry: an episode the operator didn't repick keeps its CURRENT show
  // code, re-resolved against the target outlet. A single-episode move then
  // needs one dropdown, not two.
  const resolved: Array<{ id: string; code: string }> = []
  for (const ep of b.episodes) {
    const raw = programByEpisodeDbId[ep.id] ?? ep.program?.code ?? ''
    const code = String(raw).trim().toUpperCase()
    if (!code || !getProgram(target, code)) {
      return { ok: false, error: `สังกัด ${target} ไม่มีรายการ "${code || '—'}" — เลือกรายการปลายทางให้ ${ep.episodeId} ด้วย` }
    }
    resolved.push({ id: ep.id, code })
  }
  return { ok: true, resolved }
}

// ── Drive path preview (shared with the executor so they cannot diverge) ──────

export type MovePaths = {
  oldOutletCanon: string
  newOutletCanon: string
  oldLayers: ReturnType<typeof shootFolderLayers>
  newLayers: ReturnType<typeof shootFolderLayers>
  needsMove: boolean
}

/**
 * Compute both sides of the Drive path. The bug this exists to prevent: calling
 * `shootFolderLayers` once and reusing the outlet code for both sides, which
 * yields a "new" path still rooted at the old outlet.
 */
export function movePaths(args: {
  oldOutletCode: string
  newOutletCode: string
  oldShowName: string
  newShowName: string
  oldCode: string
  newCode: string
  jobName: string | null
  category: string | null
  projectId: string | null
  projectName: string | null
}): MovePaths {
  const common = {
    category: args.category, projectId: args.projectId,
    projectName: args.projectName, jobName: args.jobName,
  }
  const oldLayers = shootFolderLayers({
    ...common, outletCode: args.oldOutletCode, showName: args.oldShowName, bookingCode: args.oldCode,
  })
  const newLayers = shootFolderLayers({
    ...common, outletCode: args.newOutletCode, showName: args.newShowName, bookingCode: args.newCode,
  })
  const oldOutletCanon = outletDriveFolderName(args.oldOutletCode)
  const newOutletCanon = outletDriveFolderName(args.newOutletCode)
  return {
    oldOutletCanon, newOutletCanon, oldLayers, newLayers,
    needsMove: boxNeedsRelocation(
      { outletCanon: oldOutletCanon, programFolder: oldLayers.programFolderName },
      { outletCanon: newOutletCanon, programFolder: newLayers.programFolderName },
    ),
  }
}

// ── planner ──────────────────────────────────────────────────────────────────

export type OutletMoveWarning = { code: string; th: string }

export type OutletMovePlan =
  | { ok: false; error: string }
  | {
      ok: true
      bookingId: string
      oldBookingCode: string
      newBookingCode: string
      from: { outletCode: string; outletName: string; showName: string }
      to: { outletCode: string; outletName: string; showName: string }
      episodeChanges: EpisodeIdChange[]
      /** ONE ENTRY PER EPISODE — Program is @@unique([code, outletId]), so even
       *  an unchanged CODE must be repointed from the old outlet's row to the
       *  target outlet's row, or booking.program would be a cross-outlet FK
       *  that Prisma accepts and nothing in the app validates. */
      programUpdates: Array<{ episodeDbId: string; programId: string; programCode: string; programName: string }>
      outletUpdate: { outletId: string; outletCode: string; outletName: string; bookingProgramId: string; bookingProgramCode: string; bookingProgramName: string }
      drive: {
        fromPath: string; toPath: string
        oldBoxName: string; newBoxName: string
        boxIdStored: string | null
        needsMove: boolean
      }
      warnings: OutletMoveWarning[]
    }

/**
 * Read the booking, validate, resolve/create the target Outlet + Program rows,
 * and compute every ID + path. `dryRun` skips the upserts entirely so a preview
 * writes nothing at all (programUpdates come back with empty ids, which the
 * route never forwards to the executor).
 */
export async function planOutletMove(input: {
  bookingId: string
  targetOutletCode: string
  programByEpisodeDbId?: Record<string, string>
  dryRun?: boolean
}): Promise<OutletMovePlan> {
  const dryRun = input.dryRun !== false
  const booking = await prisma.booking.findUnique({
    where: { id: input.bookingId },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: { sequence: 'asc' }, include: { program: true } },
    },
  })
  if (!booking) return { ok: false, error: 'ไม่พบ booking นี้' }

  const target = (input.targetOutletCode || '').trim().toUpperCase()
  const check = validateOutletMove(
    {
      bookingCode: booking.bookingCode,
      deletedAt: booking.deletedAt,
      status: booking.status,
      deliveredAt: booking.deliveredAt,
      projectId: booking.projectId,
      outletCode: booking.outlet.code,
      program: booking.program ? { code: booking.program.code } : null,
      episodes: booking.episodes.map(e => ({
        id: e.id, episodeId: e.episodeId, program: e.program ? { code: e.program.code } : null,
      })),
    },
    target,
    input.programByEpisodeDbId || {},
  )
  if (!check.ok) return { ok: false, error: check.error }

  const targetOutlet = getOutlet(target)!
  const bookingProgCode = booking.program!.code
  const bookingProgCat = getProgram(target, bookingProgCode)!

  // Sequence scan: one query per distinct target stream, moving episodes excluded
  // inside computeOutletMoveIds (they must not inflate their own sequence).
  const prefixes = moveStreamPrefixes({
    targetOutletCode: target,
    targetBookingProgramCode: bookingProgCode,
    shootDate: booking.shootDate,
    targetProgramCodes: check.resolved.map(r => r.code),
  })
  const priorByPrefix: Record<string, Array<{ id: string; episodeId: string }>> = {}
  for (const prefix of prefixes) {
    priorByPrefix[prefix] = await prisma.episode.findMany({
      where: { episodeId: { startsWith: prefix } },
      select: { id: true, episodeId: true },
    })
  }

  const codeByEp = new Map(check.resolved.map(r => [r.id, r.code]))
  const { newBookingCode, episodeChanges } = computeOutletMoveIds({
    targetOutletCode: target,
    targetBookingProgramCode: bookingProgCode,
    shootDate: booking.shootDate,
    episodes: booking.episodes.map(e => ({
      id: e.id, episodeId: e.episodeId, targetProgramCode: codeByEp.get(e.id)!,
    })),
    priorByPrefix,
    movingEpisodeDbIds: new Set(booking.episodes.map(e => e.id)),
  })
  if (!newBookingCode) return { ok: false, error: 'คำนวณเลข ID ใหม่ไม่ได้' }

  // Target Outlet + Program rows. Additive and idempotent — an abort later
  // leaves at most an unused Program row, never a broken booking.
  const upsertIgnoreRace = async <T>(up: () => Promise<T>, reread: () => Promise<T | null>): Promise<T> => {
    try { return await up() } catch (e) { const r = await reread(); if (r) return r; throw e }
  }
  let outletId = ''
  let bookingProgramId = ''
  const programUpdates: OutletMovePlanProgramUpdate[] = []
  if (!dryRun) {
    const outletDb = await upsertIgnoreRace(
      () => prisma.outlet.upsert({
        where: { code: targetOutlet.code },
        update: {},
        create: { code: targetOutlet.code, name: targetOutlet.name, notes: targetOutlet.description, sort: targetOutlet.sort },
      }),
      () => prisma.outlet.findUnique({ where: { code: targetOutlet.code } }),
    )
    outletId = outletDb.id
    const progRow = async (code: string, name: string, category: string) => upsertIgnoreRace(
      () => prisma.program.upsert({
        where: { code_outletId: { code, outletId: outletDb.id } },
        update: {},
        create: { code, name, category, outletId: outletDb.id },
      }),
      () => prisma.program.findUnique({ where: { code_outletId: { code, outletId: outletDb.id } } }),
    )
    bookingProgramId = (await progRow(bookingProgCat.code, bookingProgCat.name, bookingProgCat.category)).id
    // One entry per EPISODE — including episodes whose code didn't change.
    for (const r of check.resolved) {
      const cat = getProgram(target, r.code)!
      const row = await progRow(cat.code, cat.name, cat.category)
      programUpdates.push({ episodeDbId: r.id, programId: row.id, programCode: cat.code, programName: cat.name })
    }
  } else {
    for (const r of check.resolved) {
      const cat = getProgram(target, r.code)!
      programUpdates.push({ episodeDbId: r.id, programId: '', programCode: cat.code, programName: cat.name })
    }
  }

  // Show name for the Drive path, computed the same way bookingShowName does
  // but from the POST-move episode programs.
  const showNameFrom = showNameOf(booking.projectName, booking.program!.name, booking.episodes.map(e => e.program?.name || null))
  const showNameTo = showNameOf(booking.projectName, bookingProgCat.name, check.resolved.map(r => getProgram(target, r.code)!.name))

  const paths = movePaths({
    oldOutletCode: booking.outlet.code,
    newOutletCode: target,
    oldShowName: showNameFrom,
    newShowName: showNameTo,
    oldCode: booking.bookingCode!,
    newCode: newBookingCode,
    // jobName mirrors regenerate-booking-id.ts:194 exactly — projectName, else
    // the first episode's title. Diverging here would compute a preview path
    // the executor never produces.
    jobName: booking.projectName?.trim() || booking.episodes[0]?.title?.trim() || null,
    category: booking.category ?? null,
    projectId: booking.projectId,
    projectName: booking.projectName,
  })

  const warnings: OutletMoveWarning[] = []
  if (booking.producerEmail) {
    const inTarget = await prisma.user.findFirst({
      where: { email: booking.producerEmail.toLowerCase(), producerOutlets: { has: target } },
      select: { id: true },
    })
    if (!inTarget) {
      warnings.push({
        code: 'producer-not-in-target',
        th: `Producer ${booking.producer} ยังไม่อยู่ในทีม ${targetOutlet.name} — ถ้าอยากให้ขึ้น dropdown ต้องแก้ seed src/lib/outlet-producers.ts แล้ว deploy + กด Import (ติ๊กที่ /admin/permissions อย่างเดียวจะโดน import รอบหน้าลบทิ้ง)`,
      })
    }
  }
  const otCount = await prisma.oTRecord.count({ where: { bookingId: booking.id } })
  if (otCount > 0) {
    warnings.push({
      code: 'ot-records-stale',
      th: `OT ${otCount} รายการของงานนี้จะยังขึ้นสังกัดเดิม — ตั้งใจไม่แตะ เพราะการ sync ใหม่จะลบ OT ที่อนุมัติ (พร้อมลายเซ็น) ทิ้ง`,
    })
  }
  if (getDriveLink(booking.driveFolders, 'landing')) {
    warnings.push({ code: 'landing-exists', th: 'มีโฟลเดอร์ drop โซน NAS อยู่แล้ว — จะเปลี่ยนชื่อให้ แต่ชื่อโฟลเดอร์ฝั่ง NAS เปลี่ยนตามไม่ได้ (รายงาน sync อาจอ้างเลขเดิมสักพัก)' })
  }
  if ((booking.footageCache as { fileCount?: number } | null)?.fileCount) {
    warnings.push({ code: 'box-has-files', th: 'กล่อง Drive มีไฟล์อยู่แล้ว — ย้ายทั้งกล่อง (id เดิม) ไฟล์ไม่หาย แต่ลิงก์ที่แปะไว้ในเอกสารอื่นจะชี้ชื่อใหม่' })
  }

  return {
    ok: true,
    bookingId: booking.id,
    oldBookingCode: booking.bookingCode!,
    newBookingCode,
    from: { outletCode: booking.outlet.code, outletName: booking.outlet.name, showName: showNameFrom },
    to: { outletCode: target, outletName: targetOutlet.name, showName: showNameTo },
    episodeChanges,
    programUpdates,
    outletUpdate: {
      outletId, outletCode: target, outletName: targetOutlet.name,
      bookingProgramId, bookingProgramCode: bookingProgCat.code, bookingProgramName: bookingProgCat.name,
    },
    drive: {
      fromPath: `${paths.oldOutletCanon}/${paths.oldLayers.programFolderName}`,
      toPath: `${paths.newOutletCanon}/${paths.newLayers.programFolderName}`,
      oldBoxName: paths.oldLayers.bookingFolderName,
      newBoxName: paths.newLayers.bookingFolderName,
      boxIdStored: getDriveLink(booking.driveFolders, 'box'),
      needsMove: paths.needsMove,
    },
    warnings,
  }
}

type OutletMovePlanProgramUpdate = { episodeDbId: string; programId: string; programCode: string; programName: string }

/** bookingShowName's rule, applied to plain values so it works for the
 *  post-move (not yet persisted) programs too. */
function showNameOf(projectName: string | null, bookingProgramName: string, episodeProgramNames: Array<string | null>): string {
  const pn = projectName?.trim()
  if (pn) return pn
  const eps: string[] = []
  for (const n of episodeProgramNames) {
    const name = n?.trim()
    if (name && name !== bookingProgramName && !eps.includes(name)) eps.push(name)
  }
  if (eps.length > 0) return eps.length <= 2 ? eps.join(' / ') : `${eps[0]} +${eps.length - 1}`
  return bookingProgramName
}
