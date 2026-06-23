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
import { ensureShootCameraFolders, ensureFlatShootFolders, hasDriveCredentials } from '@/lib/google-drive'
import {
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
  camerasToPreCreate,
  hasOutletFolderMapping,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'

/** Half-open range matching bookings whose **Bangkok** shoot-day is today.
 *  `Booking.shootDate` is `@db.Date` (date-only) — Prisma returns/compares it as
 *  midnight-UTC of the calendar date. So we resolve TODAY in Bangkok (now+7h),
 *  then return that date's midnight-UTC boundaries. (An earlier version offset
 *  the boundaries by -7h; against a date column that truncated `end` and
 *  excluded today's shoots — the bug this replaces.) */
export function bangkokTodayRange(now: Date = new Date()): { start: Date; end: Date } {
  const bkk = new Date(now.getTime() + 7 * 3_600_000)
  const start = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()))
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) }
}

// v1.88 — "Production Team" landing Shared Drive (where the NAS syncs footage).
// Hardcoded default so it works without a Portainer env change; override with
// DRIVE_PRODUCTION_TEAM_ROOT if the drive ever changes.
const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

export interface PrepResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  total: number
  prepared: number
  errors: number
  prodTeamErrors: number
  results: Array<{ bookingCode: string | null; created?: string[]; prodTeam?: string; wouldCreate?: string[]; skipped?: string; error?: string }>
}

export async function prepTodayShootFolders(opts: { dryRun?: boolean } = {}): Promise<PrepResult> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) {
    return { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', dryRun: !!opts.dryRun, total: 0, prepared: 0, errors: 0, prodTeamErrors: 0, results: [] }
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
  let prodTeamErrors = 0

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
      const bookingFolderName = buildBookingFolderName(b.bookingCode!, jobName)
      // 1) destination boxes in VIDEO 2026 (outlet/program/<ID·job>/CAM-..)
      await ensureShootCameraFolders({
        rootFolderId: root,
        outletCanonicalName: outletDriveFolderName(b.outlet.code),
        programFolderName: programFolderName({
          outletCode: b.outlet.code,
          showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
          category: b.category,
        }),
        bookingFolderName,
        cameras,
      })
      // 2) v1.88 — landing folder in Production Team (flat, named by Production ID)
      //    so crew drop footage into an already-identified folder. Best-effort:
      //    a Production Team hiccup must not undo the VIDEO 2026 prep.
      let prodTeam = 'ok'
      try {
        await ensureFlatShootFolders({ rootFolderId: PRODUCTION_TEAM_ROOT, bookingFolderName, cameras })
      } catch (ptErr: any) {
        prodTeam = `error: ${ptErr?.message || ptErr}`
        prodTeamErrors++ // v1.92.1 — count it so a total Production Team outage shows in the headline log
      }
      results.push({ bookingCode: b.bookingCode, created: cameras, prodTeam })
      prepared++
    } catch (e: any) {
      results.push({ bookingCode: b.bookingCode, error: e?.message || String(e) })
      errors++
    }
  }

  return { skipped: false, dryRun: !!opts.dryRun, total: bookings.length, prepared, errors, prodTeamErrors, results }
}
