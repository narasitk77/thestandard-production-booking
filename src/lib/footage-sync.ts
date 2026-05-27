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
import { parseProductionId } from './production-id'
import { findBookingByProductionId, type ProductionIdLookup } from './booking-lookup'
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

  // 3. Classify each file
  type Decision = {
    file: DriveFile
    productionId: string | null
    booking: NonNullable<ProductionIdLookup> | null
    status: ParseStatus
    existingLog: typeof existingLogs[number] | undefined
  }
  const decisions: Decision[] = []

  for (const file of driveFiles) {
    const existing = logByFileId.get(file.id)
    if (existing?.sheetRowWritten) {
      out.seen += 1
      continue  // fully done — skip
    }
    const productionId = parseProductionId(file.name)
    let booking: Decision['booking'] = null
    let status: ParseStatus
    if (!productionId) {
      status = 'unparsed'
    } else {
      booking = await findBookingByProductionId(productionId)
      status = booking ? 'matched' : 'parsed_no_booking'
    }
    decisions.push({ file, productionId, booking, status, existingLog: existing })
  }

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
    camera: cameraFromFilename(d.file.name),
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

/**
 * Best-effort camera derivation from filename. Looks for the conventional
 * `_<token>_` segment after the Production ID and matches against known
 * camera tokens. Falls back to null — the sheet row's Camera cell stays
 * blank instead of guessing wrong.
 */
function cameraFromFilename(filename: string): string | null {
  const CAMERA_TOKENS = /(?:^|[_\-.\s])(Cam\d+|Sound|Drone|BTS|Atem|Switcher|Multi|Master|Proxy)(?:[_\-.\s]|$)/i
  const m = filename.match(CAMERA_TOKENS)
  if (!m) return null
  // Normalize Cam1/CAM1/cam1 → Cam1; others → first-letter-capitalized
  const tok = m[1]
  if (/^cam\d+$/i.test(tok)) return 'Cam' + tok.slice(3)
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()
}
