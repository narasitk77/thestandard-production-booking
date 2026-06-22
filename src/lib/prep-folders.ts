/**
 * v1.86 — pre-create the Drive destination "boxes" for the day's shoots so the
 * folders are waiting (empty CAM-A.. = that camera hasn't delivered yet). The
 * approve route already does this per-booking on CONFIRM; this is the daily/
 * hourly safety-net sweep so EVERY booking shooting today has its folders,
 * regardless of when/whether it was approved. Idempotent — ensureShootCameraFolders
 * reuses existing folders, only creates missing ones. Creates folders only (no
 * moving, no _SHOOT.txt — approve handles that).
 */
import { prisma } from '@/lib/db'
import { ensureShootCameraFolders, hasDriveCredentials } from '@/lib/google-drive'
import {
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
  camerasToPreCreate,
  hasOutletFolderMapping,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'

/** Bangkok (UTC+7) midnight..midnight range for "today" as UTC instants.
 *  The container runs UTC, so "today" must be resolved in Bangkok time. */
export function bangkokTodayRange(now: Date = new Date()): { start: Date; end: Date } {
  const bkk = new Date(now.getTime() + 7 * 3_600_000)
  const start = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3_600_000)
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) }
}

export interface PrepResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  total: number
  prepared: number
  errors: number
  results: Array<{ bookingCode: string | null; created?: string[]; wouldCreate?: string[]; skipped?: string; error?: string }>
}

export async function prepTodayShootFolders(opts: { dryRun?: boolean } = {}): Promise<PrepResult> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', dryRun: !!opts.dryRun, total: 0, prepared: 0, errors: 0, results: [] }
  }

  const { start, end } = bangkokTodayRange()
  const bookings = await prisma.booking.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      bookingCode: { not: null },
    },
    select: {
      id: true, bookingCode: true, cameraCount: true, micCount: true,
      projectName: true, category: true,
      outlet: { select: { code: true } },
      program: { select: { name: true } },
      episodes: { orderBy: { sequence: 'asc' }, select: { title: true, program: { select: { name: true } } } },
    },
  })

  const results: PrepResult['results'] = []
  let prepared = 0
  let errors = 0

  for (const b of bookings) {
    if (!hasOutletFolderMapping(b.outlet.code)) {
      results.push({ bookingCode: b.bookingCode, skipped: `outlet ${b.outlet.code} has no folder mapping` })
      continue
    }
    const cameras = camerasToPreCreate(b.cameraCount, b.micCount)
    if (cameras.length === 0) {
      results.push({ bookingCode: b.bookingCode, skipped: 'no cameras (block shot / unspecified)' })
      continue
    }
    if (opts.dryRun) {
      results.push({ bookingCode: b.bookingCode, wouldCreate: cameras })
      prepared++
      continue
    }
    try {
      const jobName = b.projectName?.trim() || b.episodes[0]?.title?.trim() || null
      await ensureShootCameraFolders({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(b.outlet.code),
        programFolderName: programFolderName({
          outletCode: b.outlet.code,
          showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
          category: b.category,
        }),
        bookingFolderName: buildBookingFolderName(b.bookingCode!, jobName),
        cameras,
      })
      results.push({ bookingCode: b.bookingCode, created: cameras })
      prepared++
    } catch (e: any) {
      results.push({ bookingCode: b.bookingCode, error: e?.message || String(e) })
      errors++
    }
  }

  return { skipped: false, dryRun: !!opts.dryRun, total: bookings.length, prepared, errors, results }
}
