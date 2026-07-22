import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import {
  hasOutletFolderMapping,
  outletDriveFolderName,
  shootFolderLayers,
  buildEpisodeFolderName,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import {
  ensureUploadFolderPath,
  createResumableUploadSession,
} from '@/lib/google-drive'
import { isDriveAccessError } from '@/lib/drive-access'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload/init
 *
 * Pre-creates the Upload + FootageLog rows and reserves a Drive file slot
 * with a resumable session URL. Returns everything the browser needs to
 * push bytes directly to Drive without going through this server.
 * (Wasabi dual-write removed — Drive is the only upload target now.)
 *
 * Request body:
 *   {
 *     bookingId:    string  — Booking.id (CUID)
 *     camera:       string  — Cam1 / Cam2 / Sound / ...
 *     filename:     string
 *     size:         number  — bytes
 *     mimeType?:    string  — default 'application/octet-stream'
 *     sha256?:      string  — browser-computed hex digest (optional, verified on complete)
 *   }
 *
 * Response: { uploadId, targets: { drive } }
 */

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 * 1024 // 500GB hard cap (v1.87; Drive itself allows 5TB)
const SAFE_FILENAME_RE = /^[A-Za-z0-9._\-()[\] ฀-๿]+$/  // ASCII + Thai

/**
 * v1.35.9 — defense-in-depth filename validator beyond the regex above.
 * The regex allows dots, parens, brackets — fine for valid filenames but
 * not enough to rule out tricky inputs like `..(foo).mp4` or `... .mp4`
 * which contain valid chars but still have path-like semantics.
 *
 * Drive ignores OS path separators (it uses ids), but the same `filename`
 * value flows into the Drive display name + (legacy) local disk.
 * Keeping it strictly file-basename-shaped is the right invariant.
 */
function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 255) return false
  // No directory separators of any flavor
  if (/[\\/]/.test(filename)) return false
  // No leading dot ("hidden" files are out of band for footage)
  if (filename.startsWith('.')) return false
  // No `..` anywhere (covers `..`, `foo..mp4`, `..bar`)
  if (filename.includes('..')) return false
  // No trailing whitespace or dot (Windows reserves these; corrupts ext)
  if (/[. ]$/.test(filename)) return false
  return SAFE_FILENAME_RE.test(filename)
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // v1.35.3 — per-booking gate runs after the body is parsed (we need the
    // booking id first). The `getUploadAccess` quick role-only check is
    // dropped — `canUploadToBooking` below subsumes it AND adds the
    // assignment + status checks in one place.

    const body = await request.json().catch(() => ({}))
    const bookingId = String(body.bookingId || '').trim()
    const camera = String(body.camera || '').trim()
    // v1.93 — which episode this file belongs to (Episode.id / CUID). Picks the
    // per-EP destination folder + tags Upload.episodeId. Optional: defaults to
    // the first episode; absent for bookings that have no episodes.
    const episodeRowId = body.episodeRowId ? String(body.episodeRowId).trim() : ''
    const filename = String(body.filename || '').trim()
    const size = Number(body.size)
    const mimeType = String(body.mimeType || 'application/octet-stream').trim()
    const sha256 = body.sha256 ? String(body.sha256).trim() : null

    // 1. Validate inputs
    if (!bookingId) return NextResponse.json({ error: 'bookingId is required' }, { status: 400 })
    if (!camera) return NextResponse.json({ error: 'camera is required' }, { status: 400 })
    if (!filename) return NextResponse.json({ error: 'filename is required' }, { status: 400 })
    if (!Number.isFinite(size) || size <= 0) {
      return NextResponse.json({ error: 'size must be a positive integer (bytes)' }, { status: 400 })
    }
    if (size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: `size exceeds ${MAX_FILE_SIZE_BYTES} bytes hard cap` }, { status: 400 })
    }
    if (!isSafeFilename(filename)) {
      return NextResponse.json({
        error: 'filename has unsafe characters or path-like tokens — keep it to plain ASCII/Thai alphanumeric + dot/dash/underscore/parens/brackets, no leading dot, no `..`, no trailing dot or space',
      }, { status: 400 })
    }
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
      return NextResponse.json({ error: 'sha256 must be 64 hex chars' }, { status: 400 })
    }

    // 2. Load booking + outlet (+ fields the booking-info.txt needs)
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        assignedEmails: true,
        deletedAt: true, // v1.51 — canUploadToBooking rejects deleted bookings
        // --- booking-info.txt context ---
        projectName: true,
        projectId: true,
        category: true,
        videoType: true,
        shootType: true,
        shootDate: true,
        shootEndDate: true,
        callTime: true,
        estimatedWrap: true,
        locationName: true,
        producer: true,
        producerEmail: true,
        director: true,
        directorEmail: true,
        mainVideographerEmail: true,
        crewRequired: true,
        agencyRef: true,
        notes: true,
        outlet: { select: { code: true, name: true } },
        // v1.70 — program name (booking-level + per-episode) drives the new
        // Drive "program / รายการ" folder layer via bookingShowName().
        program: { select: { name: true } },
        episodes: {
          orderBy: { sequence: 'asc' },
          select: { id: true, episodeId: true, title: true, sequence: true, program: { select: { name: true } } },
        },
      },
    })
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    if (!booking.bookingCode) {
      return NextResponse.json({ error: 'Booking has no Production ID — assign one before uploading' }, { status: 400 })
    }
    // v1.35.3 — combined gate: role + status + assignment (admin bypasses
    // assignment). Mirrors the UI's visibility check exactly so a
    // hand-crafted POST gets the same answer as the rendered page would.
    const check = await canUploadToBooking(session.email, {
      id: booking.id, status: booking.status, assignedEmails: booking.assignedEmails,
    })
    if (!check.ok) {
      const code = check.reason ?? 'FORBIDDEN'
      const errMap: Record<string, string> = {
        NO_UPLOAD_ROLE: 'Upload requires video/sound team role or admin',
        NOT_ASSIGNED:   'You are not assigned to this booking — only assigned crew can upload',
        BAD_STATUS:     `Booking is ${booking.status} — uploads only allowed for CONFIRMED or COMPLETED`,
        BOOKING_NOT_FOUND: 'Booking not found',
        FORBIDDEN: 'Upload forbidden for this booking',
      }
      return NextResponse.json({ error: errMap[code], code }, { status: 403 })
    }
    if (!hasOutletFolderMapping(booking.outlet.code)) {
      return NextResponse.json({
        error: `Outlet "${booking.outlet.code}" has no folder mapping — add to src/lib/outlet-folders.ts before uploading`,
        code: 'NO_OUTLET_FOLDER',
      }, { status: 400 })
    }

    // 3. Drive is the only upload target (Wasabi dual-write removed).
    if (!process.env.DRIVE_FOOTAGE_ROOT?.trim()) {
      return NextResponse.json({
        error: 'DRIVE_FOOTAGE_ROOT env var is not set. Admin: set it in the Portainer stack to the Shared Drive root folder id (VIDEO 2026 [JUL–DEC] = 0AH7f4FZNrHsOUk9PVA) and redeploy.',
        code: 'DRIVE_NOT_CONFIGURED',
      }, { status: 503 })
    }

    // v1.93 — multi-EP: the file lands in a per-episode subfolder so episodes
    // aren't all mixed in one camera folder. The uploader picks which EP;
    // default to the first. Bookings with no episodes keep the flat
    // <booking>/<camera>/ layout (episodeFolderName stays undefined).
    let selectedEp: { id: string; sequence: number; title: string } | null = null
    if (booking.episodes.length > 0) {
      selectedEp = episodeRowId
        ? booking.episodes.find(e => e.id === episodeRowId) ?? null
        : booking.episodes[0]
      if (!selectedEp) {
        return NextResponse.json(
          { error: 'episodeRowId does not match any episode on this booking', code: 'BAD_EPISODE' },
          { status: 400 },
        )
      }
    } else if (episodeRowId) {
      // Booking has no episodes but the client named one — surface it rather
      // than silently dropping the file into the flat (no-EP) folder.
      return NextResponse.json(
        { error: 'episodeRowId provided but this booking has no episodes', code: 'BAD_EPISODE' },
        { status: 400 },
      )
    }
    // v1.94 — Content Agency files EP folders by project EP ID; others by EP01.
    const isAgency = booking.outlet.code === 'AGN'
    const episodeFolderName = selectedEp ? buildEpisodeFolderName(selectedEp, { useEpisodeId: isAgency }) : undefined

    // 4. Compute Drive path.
    //   AGN → <outlet>/<Project ID · name>/<job (AGN-…)>/<EP ID · title>/<camera>/;
    //   others → <outlet>/<show>/<Production ID · job>/<EP01 · title>/<camera>/.
    const jobName =
      (booking.projectName && booking.projectName.trim()) ||
      (booking.episodes[0]?.title && booking.episodes[0].title.trim()) ||
      null
    // v1.94 — the program + per-booking layers, AGN-aware. v1.112 — AGN nests a
    // per-booking "<job> (<code>)" layer inside the shared project box.
    const { programFolderName: driveProgramFolder, bookingFolderName, bookingSubfolderName: driveBookingSubfolder } = shootFolderLayers({
      outletCode: booking.outlet.code,
      showName: bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes }),
      category: booking.category,
      projectId: booking.projectId,
      projectName: booking.projectName,
      bookingCode: booking.bookingCode,
      jobName,
    })

    // 5. Create Upload row first (lets us reference its id below)
    const upload = await prisma.upload.create({
      data: {
        bookingId: booking.id,
        episodeId: selectedEp?.id ?? null, // v1.93 — per-EP attribution
        camera,
        fileName: filename,
        fileSize: BigInt(size),
        mimeType,
        uploadedBy: session.email,
        sha256: sha256 ?? null,
        status: 'UPLOADING',
        initiatedAt: new Date(),
      },
    })

    // 6. Drive — ensure folder path + reserve file slot + resumable session.
    //   Lands in <root>/<existing outlet folder>/<Production ID - job>/<camera>/
    //   v1.84 — act AS the uploader (DWD) so Drive shows the real person as the
    //   file's creator. If they lack Shared Drive access (403/404 on the first
    //   folder op), fall back to the default service subject so uploads never
    //   break — see [[isDriveAccessError]].
    //
    // v1.80.1 — the browser PUTs chunks cross-origin to googleapis.com; Drive
    // only returns Access-Control-Allow-Origin on those PUT responses when the
    // origin was registered at session init. Header is authoritative; env is the
    // fallback if a proxy strips it.
    const browserOrigin = request.headers.get('origin')
      || process.env.NEXTAUTH_URL
      || process.env.NEXT_PUBLIC_APP_URL
      || undefined

    const setupDrive = async (subject?: string) => {
      const { cameraFolderId } = await ensureUploadFolderPath({
        rootFolderId: process.env.DRIVE_FOOTAGE_ROOT!.trim(),
        outletCanonicalName: outletDriveFolderName(booking.outlet.code),
        programFolderName: driveProgramFolder,
        bookingFolderName,
        // v1.112 — AGN: uploads land inside the per-booking layer of the project box.
        bookingSubfolderName: driveBookingSubfolder,
        bookingSubfolderCode: booking.bookingCode ?? undefined,
        // AGN box is keyed by projectId (not bookingCode) — v1.149: matched by
        // that projectId (rename/name-drift tolerant), no longer exact-name.
        bookingCode: booking.outlet.code === 'AGN' ? undefined : (booking.bookingCode ?? undefined),
        bookingFolderCode: booking.outlet.code === 'AGN' ? (booking.projectId ?? undefined) : undefined,
        episodeFolderName,
        camera,
        subject,
      })
      // v1.111 — _SHOOT.txt is written ONCE by the approve flow (the canonical
      // writer). Writing it here per-file made bulk uploads fire many parallel
      // writes that raced into duplicate _SHOOT files, so it's removed.
      return createResumableUploadSession({
        parentFolderId: cameraFolderId, filename, mimeType, size, origin: browserOrigin, subject,
      })
    }

    let driveTarget: { fileId: string; sessionUrl: string } | null = null
    try {
      let driveSession
      try {
        driveSession = await setupDrive(session.email)  // act as the uploader
      } catch (e: any) {
        if (isDriveAccessError(e)) {
          console.warn(`[upload/init] uploader ${session.email} lacks Shared Drive access — using default Drive subject (${e?.message || e})`)
          driveSession = await setupDrive(undefined)     // fall back to service subject
        } else {
          throw e
        }
      }
      driveTarget = driveSession
      // Tie the reserved Drive file id to the Upload row so /complete can verify it
      await prisma.upload.update({
        where: { id: upload.id },
        data: { driveFileId: driveSession.fileId },
      })
      // Pre-create FootageLog so the v1.34 footage scanner skips this file
      // (scanner sees Upload.driveFileId match + skips — handled in
      //  src/lib/footage-sync.ts).
      await prisma.footageLog.upsert({
        where: { driveFileId: driveSession.fileId },
        create: {
          driveFileId: driveSession.fileId,
          productionId: booking.bookingCode,
          bookingId: booking.id,
          filename,
          parseStatus: 'matched',
          sheetRowWritten: false,
        },
        update: { productionId: booking.bookingCode, bookingId: booking.id, parseStatus: 'matched' },
      })
    } catch (e: any) {
      await prisma.upload.update({
        where: { id: upload.id },
        data: { status: 'FAILED', failureReason: `Drive init: ${e?.message || String(e)}` },
      })
      return NextResponse.json({ error: `Failed to initiate Drive upload: ${e?.message || e}` }, { status: 502 })
    }

    return NextResponse.json({
      uploadId: upload.id,
      bookingCode: booking.bookingCode,
      outletFolder: outletDriveFolderName(booking.outlet.code),
      targets: {
        drive: driveTarget,
      },
    })
  } catch (e: any) {
    console.error('POST /api/upload/init error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
