/**
 * Footage sync — pure-business-logic core. Called by:
 *   - GET /api/internal/footage/sync  (worker poll endpoint)
 *   - admin / dryRun callers (future)
 *
 * Algorithm per tick:
 *   1. listFilesRecursive(DRIVE_FOOTAGE_ROOT) — walk Shared Drive
 *   2. For each file: skip if FootageLog already has driveFileId
 *   3. parseProductionId(file.name) → maybe code
 *   4. If code → findBookingByProductionId(code) → matched | parsed_no_booking
 *      Else → unparsed
 *   5. For files in "matched" state, build FootageInput, batch
 *   6. appendFootageRows(batch) writes to user's sheet
 *   7. Always create FootageLog row (with sheetRowWritten reflecting whether
 *      step 6 ran for that file) so the next tick's dedupe works
 *
 * Files in `parsed_no_booking` / `unparsed` states are recorded but NOT
 * written to the sheet — the sheet is the "matched footage" log, not the
 * raw "everything in Drive" inventory. Their FootageLog rows are useful
 * for `select * from footage_log where parseStatus != 'matched'`-style
 * triage queries.
 *
 * Idempotent + crash-safe: a partial run that wrote sheet rows but
 * crashed before logging will double-write on the next tick. To prevent
 * that, FootageLog rows are created BEFORE the sheet append in `matched`
 * mode with `sheetRowWritten: false`, then patched to true after success.
 * A pre-existing FootageLog with `sheetRowWritten=false` is retried.
 */

import { prisma } from './db'
import { listFilesRecursive, hasDriveCredentials, type DriveFile } from './google-drive'
import { findProductionIdInPath } from './production-id'
import { findBookingsByProductionIds, type ProductionIdLookup } from './booking-lookup'
import { appendFootageRows, probeSheet, type FootageInput } from './footage-sheet'

export type ParseStatus = 'matched' | 'parsed_no_booking' | 'unparsed'

export interface SyncResult {
  ok: boolean
  reason?: string
  scanned: number      // files returned by Drive list
  seen: number         // already in FootageLog with sheetRowWritten=true (skipped fully)
  matched: number      // wrote sheet row + log row this tick
  parsedNoBooking: number
  unparsed: number
  retried: number      // existing log rows whose sheet write we re-attempted
  errors: string[]
}

export async function runFootageSync(opts: { dryRun?: boolean } = {}): Promise<SyncResult> {
  const out: SyncResult = {
    ok: false,
    scanned: 0, seen: 0, matched: 0, parsedNoBooking: 0, unparsed: 0, retried: 0,
    errors: [],
  }

  const rootFolderId = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!rootFolderId) {
    out.reason = 'DRIVE_FOOTAGE_ROOT env var not set — worker idle'
    return out
  }
  if (!hasDriveCredentials()) {
    out.reason = 'service account credentials missing — worker idle'
    return out
  }
  if (!process.env.FOOTAGE_LOG_SHEET_ID?.trim()) {
    out.reason = 'FOOTAGE_LOG_SHEET_ID env var not set — worker idle'
    return out
  }

  // Pre-flight the sheet probe so a misconfigured tab name fails fast with a
  // clear message instead of after a Drive walk.
  let probe
  try {
    probe = await probeSheet()
  } catch (e: any) {
    out.reason = `probeSheet failed: ${e?.message || e}`
    return out
  }
  if (!probe || probe.rawHeaders.length === 0) {
    out.reason = `footage sheet ${probe?.sheetId} has no header row in tab "${probe?.tabName}"`
    return out
  }

  // 1. Drive walk
  let driveFiles: DriveFile[]
  try {
    driveFiles = await listFilesRecursive(rootFolderId)
  } catch (e: any) {
    out.reason = `Drive list failed: ${e?.message || e}`
    return out
  }
  out.scanned = driveFiles.length

  if (driveFiles.length === 0) {
    out.ok = true
    return out
  }

  // 2. Bulk-load existing FootageLog rows for these files (one query, not N)
  const driveFileIds = driveFiles.map(f => f.id)
  const existingLogs = await prisma.footageLog.findMany({
    where: { driveFileId: { in: driveFileIds } },
    select: { driveFileId: true, sheetRowWritten: true, parseStatus: true },
  })
  const logByFileId = new Map(existingLogs.map(l => [l.driveFileId, l]))

  // v1.35.1 — skip files our /api/upload flow owns (their `Upload` row's
  // /complete handler writes the sheet row; if we also wrote one we'd get
  // a duplicate).
  //
  // v1.35.8 — refined: skip ONLY when the Upload is in-flight (not
  // COMPLETE yet) or known FAILED. If status is COMPLETE but the
  // FootageLog still has sheetRowWritten=false, /complete's sheet append
  // crashed and never recovered — we DO want the scanner to pick it up
  // and write the row, otherwise the file is forever invisible in the
  // footage log. Same logic when status is COMPLETE but no FootageLog
  // row exists (extreme edge case — manual DB tweaking, partial state).
  const appOwnedUploads = await prisma.upload.findMany({
    where: { driveFileId: { in: driveFileIds } },
    select: { driveFileId: true, status: true },
  })
  const appOwnedSkip = new Set<string>()
  for (const u of appOwnedUploads) {
    if (!u.driveFileId) continue
    // Status flow: PENDING → UPLOADING → (DRIVE_OK | WASABI_OK) → COMPLETE
    // or → FAILED / ORPHANED. We let the scanner take over only for
    // COMPLETE rows where /complete failed to write the sheet row.
    if (u.status !== 'COMPLETE') {
      appOwnedSkip.add(u.driveFileId)
      continue
    }
    // COMPLETE — let it through ONLY if FootageLog says sheet wasn't
    // written. The log lookup happened earlier (logByFileId); if the
    // log exists and is already written, skip; otherwise process.
    const existing = logByFileId.get(u.driveFileId)
    if (existing?.sheetRowWritten) {
      appOwnedSkip.add(u.driveFileId)
    }
    // else: fall through — process this file (scanner writes sheet row)
  }

  // 3. Classify each file
  // First pass: parse Production ID from folder path, surface look-alikes
  // (lowercase typos, near-miss formats) as warnings so the operator can
  // fix the folder name instead of watching files sit in `unparsed` forever.
  type FirstPass = {
    file: DriveFile
    productionId: string | null
    existingLog: typeof existingLogs[number] | undefined
  }
  const firstPass: FirstPass[] = []
  const lookAlikeWarnings = new Map<string, string>()  // folder → normalized guess

  for (const file of driveFiles) {
    const existing = logByFileId.get(file.id)
    if (existing?.sheetRowWritten) {
      out.seen += 1
      continue  // fully done — skip
    }
    // v1.35.1 — file owned by an /api/upload row → app handles the sheet
    // write inside /api/upload/complete. Scanner stays out of its way
    // UNLESS the Upload is COMPLETE + the FootageLog says sheet write
    // failed (recovery path — see appOwnedSkip computation above).
    if (appOwnedSkip.has(file.id)) {
      out.seen += 1
      continue
    }
    // Production ID lives on the FOLDER name, not the filename
    // (`episode-id.ts` policy: "ID on folder name, not individual files").
    // Walk the file's folderPath leaf → root and pick the closest match;
    // also collect look-alikes (e.g. lowercase typos) for triage.
    const pathMatch = findProductionIdInPath(file.folderPath)
    for (const la of pathMatch.lookAlikes) lookAlikeWarnings.set(la.folder, la.normalized)
    firstPass.push({ file, productionId: pathMatch.productionId, existingLog: existing })
  }

  // Surface look-alike folder names ONCE per tick (deduped via map). The
  // operator sees them in container logs and can rename the folder so the
  // next tick picks the file up properly.
  lookAlikeWarnings.forEach((normalized, folder) => {
    console.warn(`[footage-sync] folder "${folder}" looks like a Production ID — strict format requires "${normalized}". Check for case/separator typo.`)
  })

  // Second pass: single batched Prisma query for all distinct production
  // IDs across the tick. Replaces N sequential findUniques with 1
  // findMany — matters when a first-time scan hits 1000+ matched files.
  const allCodes = firstPass.map(p => p.productionId).filter((v): v is string => !!v)
  const bookingMap = await findBookingsByProductionIds(allCodes)

  type Decision = {
    file: DriveFile
    productionId: string | null
    booking: NonNullable<ProductionIdLookup> | null
    status: ParseStatus
    existingLog: typeof existingLogs[number] | undefined
  }
  const decisions: Decision[] = firstPass.map(p => {
    const booking = p.productionId ? (bookingMap.get(p.productionId) ?? null) : null
    let status: ParseStatus
    if (!p.productionId) status = 'unparsed'
    else status = booking ? 'matched' : 'parsed_no_booking'
    return { file: p.file, productionId: p.productionId, booking, status, existingLog: p.existingLog }
  })

  if (opts.dryRun) {
    for (const d of decisions) {
      if (d.status === 'matched') out.matched += 1
      else if (d.status === 'parsed_no_booking') out.parsedNoBooking += 1
      else out.unparsed += 1
      if (d.existingLog) out.retried += 1
    }
    out.ok = true
    return out
  }

  // 4. Upsert FootageLog rows BEFORE the sheet write so a crash mid-append
  // doesn't leave the sheet ahead of the ledger. sheetRowWritten=false here
  // — patched to true after appendFootageRows succeeds.
  for (const d of decisions) {
    try {
      await prisma.footageLog.upsert({
        where: { driveFileId: d.file.id },
        create: {
          driveFileId: d.file.id,
          productionId: d.productionId,
          bookingId: d.booking?.id ?? null,
          filename: d.file.name,
          driveUrl: d.file.webViewLink,
          parseStatus: d.status,
          sheetRowWritten: false,
        },
        update: {
          productionId: d.productionId,
          bookingId: d.booking?.id ?? null,
          parseStatus: d.status,
        },
      })
      if (d.existingLog) out.retried += 1
    } catch (e: any) {
      out.errors.push(`upsert log ${d.file.id}: ${e?.message || e}`)
    }
  }

  // 5. Build sheet-row payloads from `matched` decisions
  const matchedDecisions = decisions.filter(d => d.status === 'matched')
  const rows: FootageInput[] = matchedDecisions.map(d => ({
    productionId: d.productionId,
    filename: d.file.name,
    // Camera convention: check folder names first (e.g.
    // AGN-…/Cam1/001.mp4), then fall back to filename tokens
    // (Cam1_001.mp4). Folder-first matches the team's actual layout.
    camera: cameraFromPath(d.file.folderPath) ?? cameraFromFilename(d.file.name),
    timestamp: d.file.modifiedTime || d.file.createdTime || null,
    driveLink: d.file.webViewLink,
    driveFileId: d.file.id,
    bookingStatus: 'matched',
    outletName: d.booking?.outlet?.name ?? null,
    programName: d.booking?.program?.name ?? null,
    shootDate: d.booking?.shootDate ?? null,
    producer: d.booking?.producer ?? null,
    uploader: null, // Drive doesn't expose uploader email by default; future enrichment
  }))

  if (rows.length > 0) {
    try {
      await appendFootageRows(rows)
    } catch (e: any) {
      out.errors.push(`sheet append (${rows.length} rows): ${e?.message || e}`)
      // Don't mark sheetRowWritten on the log rows we just upserted — next
      // tick will retry these (their FootageLog still has sheetRowWritten=false).
      // Tally goes to errors; matched stays 0 for this tick.
      for (const d of decisions) {
        if (d.status === 'parsed_no_booking') out.parsedNoBooking += 1
        else if (d.status === 'unparsed') out.unparsed += 1
      }
      return out
    }

    // 6. Patch sheetRowWritten=true on the just-appended rows
    const writtenIds = matchedDecisions.map(d => d.file.id)
    await prisma.footageLog.updateMany({
      where: { driveFileId: { in: writtenIds } },
      data: { sheetRowWritten: true },
    })
  }

  for (const d of decisions) {
    if (d.status === 'matched') out.matched += 1
    else if (d.status === 'parsed_no_booking') out.parsedNoBooking += 1
    else out.unparsed += 1
  }
  out.ok = out.errors.length === 0
  return out
}

// Known camera/source tokens — matched against either a folder name
// (whole-string) or a filename segment between separators. Adding a new
// camera is a one-line change to this regex source.
const CAMERA_TOKEN_RE = /^(Cam\d+|Sound|Drone|BTS|Atem|Switcher|Multi|Master|Proxy)$/i
const CAMERA_FILENAME_RE = /(?:^|[_\-.\s])(Cam\d+|Sound|Drone|BTS|Atem|Switcher|Multi|Master|Proxy)(?:[_\-.\s]|$)/i

function normalizeCameraToken(tok: string): string {
  if (/^cam\d+$/i.test(tok)) return 'Cam' + tok.slice(3)
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()
}

/**
 * Best-effort camera derivation from the file's ancestor folder names.
 * Used first because the team's real layout puts camera in a folder:
 *   AGN-260423-EVT-01/Cam1/001.mp4
 * Returns the closest matching folder name (leaf → root walk), or null
 * if none of the ancestor folders is a known camera token.
 */
function cameraFromPath(folderPath: string[]): string | null {
  if (!folderPath || folderPath.length === 0) return null
  for (let i = folderPath.length - 1; i >= 0; i--) {
    const name = folderPath[i]
    if (CAMERA_TOKEN_RE.test(name)) return normalizeCameraToken(name)
  }
  return null
}

/**
 * Fallback camera derivation from the filename itself. Used only when
 * the folder structure didn't carry the camera info — e.g.
 *   AGN-260423-EVT-01/Cam1_001.mp4    ← Cam1 lives in filename
 */
function cameraFromFilename(filename: string): string | null {
  const m = filename.match(CAMERA_FILENAME_RE)
  return m ? normalizeCameraToken(m[1]) : null
}
