import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import {
  buildStoragePath,
  hasOutletFolderMapping,
  outletDriveFolderName,
  programFolderName,
  buildBookingFolderName,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import {
  isWasabiConfigured,
  createMultipart,
  presignParts,
  chooseChunkSize,
  buildKey,
  getWasabiKeyPrefix,
  getWasabiBucket,
} from '@/lib/wasabi'
import {
  ensureUploadFolderPath,
  createResumableUploadSession,
  deleteDriveFile,
  upsertTextFile,
} from '@/lib/google-drive'
import { renderBookingInfo, bookingInfoInput } from '@/lib/booking-info'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload/init
 *
 * Pre-creates the Upload + FootageLog rows, reserves a Drive file slot
 * with a resumable session URL, and (when the outlet requires or the
 * operator opts in) initiates a Wasabi multipart upload with N presigned
 * PUT URLs. Returns everything the browser needs to push bytes directly
 * to the clouds without going through this server.
 *
 * Request body:
 *   {
 *     bookingId:    string  — Booking.id (CUID)
 *     camera:       string  — Cam1 / Cam2 / Sound / ...
 *     filename:     string
 *     size:         number  — bytes
 *     mimeType?:    string  — default 'application/octet-stream'
 *     sha256?:      string  — browser-computed hex digest (optional, verified on complete)
 *     includeWasabi?: boolean — DRIVE_ONLY outlets opt in (DUAL_WRITE always includes)
 *   }
 *
 * Response: { uploadId, targets: { drive?, wasabi? }, chunkSize? }
 */

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 * 1024 // 100GB hard cap
const SAFE_FILENAME_RE = /^[A-Za-z0-9._\-()[\] ฀-๿]+$/  // ASCII + Thai

/**
 * v1.35.9 — defense-in-depth filename validator beyond the regex above.
 * The regex allows dots, parens, brackets — fine for valid filenames but
 * not enough to rule out tricky inputs like `..(foo).mp4` or `... .mp4`
 * which contain valid chars but still have path-like semantics.
 *
 * Drive ignores OS path separators (it uses ids), but the same `filename`
 * value flows into the Wasabi key + the Drive display name + (legacy)
 * local disk. Keeping it strictly file-basename-shaped is the right
 * invariant.
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
    const filename = String(body.filename || '').trim()
    const size = Number(body.size)
    const mimeType = String(body.mimeType || 'application/octet-stream').trim()
    const sha256 = body.sha256 ? String(body.sha256).trim() : null
    const operatorWantsWasabi = body.includeWasabi === true

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
        outlet: { select: { code: true, name: true, storagePolicy: true } },
        // v1.70 — program name (booking-level + per-episode) drives the new
        // Drive "program / รายการ" folder layer via bookingShowName().
        program: { select: { name: true } },
        episodes: {
          orderBy: { sequence: 'asc' },
          select: { episodeId: true, title: true, sequence: true, program: { select: { name: true } } },
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

    // 3. Determine which clouds we're writing to.
    //   v1.72 — Wasabi is OFF by default (Drive-only). Set WASABI_ENABLED=1 in
    //   the stack env to turn the dual-write archive back on; until then every
    //   upload goes to Drive only, regardless of outlet storagePolicy or the
    //   per-upload "include Wasabi" opt-in.
    const policy = booking.outlet.storagePolicy
    const wasabiEnabled = process.env.WASABI_ENABLED === '1'
    const wantWasabi = wasabiEnabled && (policy === 'DUAL_WRITE' || operatorWantsWasabi)
    if (wantWasabi && !isWasabiConfigured()) {
      // v1.35.12 — surface which env vars are missing so the admin can
      // see at a glance what to set in Portainer instead of going to a
      // separate diagnostic page.
      const missing = ([
        ['WASABI_ENDPOINT', process.env.WASABI_ENDPOINT],
        ['WASABI_REGION', process.env.WASABI_REGION],
        ['WASABI_BUCKET', process.env.WASABI_BUCKET],
        ['WASABI_ACCESS_KEY', process.env.WASABI_ACCESS_KEY],
        ['WASABI_SECRET_KEY', process.env.WASABI_SECRET_KEY],
      ]).filter(([, v]) => !v?.trim()).map(([k]) => k)
      return NextResponse.json({
        error: `Wasabi is required for outlet "${booking.outlet.code}" (storagePolicy=DUAL_WRITE) but is not configured. Admin: set the following env vars in the Portainer stack and redeploy — ${missing.join(', ')}. Diagnose at /api/admin/upload-config.`,
        code: 'WASABI_NOT_CONFIGURED',
        missingEnvVars: missing,
        outletPolicy: policy,
        adminAction: 'Set WASABI_* env vars in Portainer stack → Pull and redeploy. Verify via /api/admin/upload-config (wasabiPing.ok = true).',
      }, { status: 503 })
    }
    if (!process.env.DRIVE_FOOTAGE_ROOT?.trim()) {
      return NextResponse.json({
        error: 'DRIVE_FOOTAGE_ROOT env var is not set. Admin: set it in the Portainer stack to the Shared Drive root folder id (VIDEO 2026 [JUL–DEC] = 0AH7f4FZNrHsOUk9PVA) and redeploy.',
        code: 'DRIVE_NOT_CONFIGURED',
      }, { status: 503 })
    }

    // 4. Compute paths.
    //   Wasabi: stable ASCII key — <prefix>/<OUTLET>/<bookingCode>/<camera>/<file>
    //   Drive : reuse the team's existing outlet folder + a human booking
    //           folder "<Production ID> - <job name>" (resolved in step 6).
    const segments = buildStoragePath(booking.outlet.code, booking.bookingCode, camera, filename)
    const wasabiKey = buildKey(getWasabiKeyPrefix(), segments)

    // "job name" the producer set — projectName for Content Agency, else the
    // lead episode's title, else nothing (folder is just the Production ID).
    const jobName =
      (booking.projectName && booking.projectName.trim()) ||
      (booking.episodes[0]?.title && booking.episodes[0].title.trim()) ||
      null
    const bookingFolderName = buildBookingFolderName(booking.bookingCode, jobName)

    // v1.70 (issue #5) — the new Drive "program / รายการ" layer. Outlet shows →
    // real show name (bookingShowName); Content Agency → category box.
    const driveProgramFolder = programFolderName({
      outletCode: booking.outlet.code,
      showName: bookingShowName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes }),
      category: booking.category,
    })

    // 5. Create Upload row first (lets us reference its id below)
    const upload = await prisma.upload.create({
      data: {
        bookingId: booking.id,
        camera,
        fileName: filename,
        fileSize: BigInt(size),
        mimeType,
        uploadedBy: session.email,
        sha256: sha256 ?? null,
        status: 'UPLOADING',
        initiatedAt: new Date(),
        wasabiBucket: wantWasabi ? getWasabiBucket() : null,
        wasabiKey: wantWasabi ? wasabiKey : null,
      },
    })

    // 6. Drive — ensure folder path + reserve file slot + resumable session.
    //   Lands in <root>/<existing outlet folder>/<Production ID - job>/<camera>/
    let driveTarget: { fileId: string; sessionUrl: string } | null = null
    try {
      const { bookingFolderId, cameraFolderId } = await ensureUploadFolderPath({
        rootFolderId: process.env.DRIVE_FOOTAGE_ROOT!.trim(),
        outletCanonicalName: outletDriveFolderName(booking.outlet.code),
        programFolderName: driveProgramFolder,
        bookingFolderName,
        camera,
      })

      // Drop / refresh _SHOOT.txt at the shoot-folder level so editors who open
      // the folder have the shoot's context. Best-effort: never let an info-file
      // hiccup block the actual footage upload.
      try {
        await upsertTextFile({
          parentFolderId: bookingFolderId,
          name: '_SHOOT.txt',
          content: renderBookingInfo(bookingInfoInput(booking)),
        })
      } catch (infoErr: any) {
        console.error('_SHOOT.txt write failed (non-fatal):', infoErr?.message || infoErr)
      }

      const driveSession = await createResumableUploadSession({
        parentFolderId: cameraFolderId,
        filename,
        mimeType,
        size,
        // v1.80.1 — the browser PUTs chunks cross-origin to googleapis.com;
        // Drive only returns Access-Control-Allow-Origin on those PUT responses
        // when the origin was registered HERE. Header is authoritative (matches
        // the browser exactly); env is the fallback if a proxy strips it.
        origin: request.headers.get('origin')
          || process.env.NEXTAUTH_URL
          || process.env.NEXT_PUBLIC_APP_URL
          || undefined,
      })
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

    // 7. Wasabi — initiate multipart + presign N parts
    let wasabiTarget: {
      uploadId: string; bucket: string; key: string;
      parts: Array<{ partNumber: number; url: string }>;
      chunkSize: number;
    } | null = null
    if (wantWasabi) {
      try {
        const chunkSize = chooseChunkSize(size)
        const partCount = Math.max(1, Math.ceil(size / chunkSize))
        const init = await createMultipart(wasabiKey, mimeType)
        const parts = await presignParts(wasabiKey, init.uploadId, partCount)
        wasabiTarget = {
          uploadId: init.uploadId,
          bucket: init.bucket,
          key: init.key,
          parts,
          chunkSize,
        }
        await prisma.upload.update({
          where: { id: upload.id },
          data: { wasabiMultipartId: init.uploadId },
        })
      } catch (e: any) {
        // v1.35.8 — Drive succeeded but Wasabi failed. DUAL_WRITE means
        // the upload can't proceed, so roll back the Drive reservation
        // inline (instead of leaving an orphan empty file slot for the
        // future reconciler to find). Best-effort: if the cleanup itself
        // fails, the FAILED row still includes both errors in
        // failureReason so triage isn't blind.
        const wasabiReason = e?.message || String(e)
        let cleanupNote = ''
        if (driveTarget?.fileId) {
          try {
            await deleteDriveFile(driveTarget.fileId)
            await prisma.footageLog.delete({ where: { driveFileId: driveTarget.fileId } }).catch(() => {})
            cleanupNote = ' · drive slot rolled back'
          } catch (cleanupErr: any) {
            cleanupNote = ` · drive cleanup failed: ${cleanupErr?.message || cleanupErr}`
          }
        }
        await prisma.upload.update({
          where: { id: upload.id },
          data: { status: 'FAILED', failureReason: `Wasabi init: ${wasabiReason}${cleanupNote}` },
        })
        return NextResponse.json({ error: `Failed to initiate Wasabi upload: ${wasabiReason}` }, { status: 502 })
      }
    }

    return NextResponse.json({
      uploadId: upload.id,
      bookingCode: booking.bookingCode,
      outletFolder: outletDriveFolderName(booking.outlet.code),
      targets: {
        drive: driveTarget,
        wasabi: wasabiTarget,
      },
    })
  } catch (e: any) {
    console.error('POST /api/upload/init error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
