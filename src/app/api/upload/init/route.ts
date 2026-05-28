import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { buildStoragePath, hasOutletFolderMapping, outletFolderName } from '@/lib/outlet-folders'
import {
  isWasabiConfigured,
  createMultipart,
  presignParts,
  chooseChunkSize,
  buildKey,
  getWasabiKeyPrefix,
  getWasabiBucket,
} from '@/lib/wasabi'
import { ensureFolderPath, createResumableUploadSession } from '@/lib/google-drive'

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
    if (!SAFE_FILENAME_RE.test(filename)) {
      return NextResponse.json({
        error: 'filename has unsafe characters — allowed: ASCII alphanumeric, Thai, space, dot, dash, underscore, parens, brackets',
      }, { status: 400 })
    }
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
      return NextResponse.json({ error: 'sha256 must be 64 hex chars' }, { status: 400 })
    }

    // 2. Load booking + outlet
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        assignedEmails: true,
        outlet: { select: { code: true, name: true, storagePolicy: true } },
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

    // 3. Determine which clouds we're writing to
    const policy = booking.outlet.storagePolicy
    const wantWasabi = policy === 'DUAL_WRITE' || operatorWantsWasabi
    if (wantWasabi && !isWasabiConfigured()) {
      return NextResponse.json({
        error: 'Wasabi is required for this outlet but WASABI_* env vars are not set',
        code: 'WASABI_NOT_CONFIGURED',
      }, { status: 503 })
    }
    if (!process.env.DRIVE_FOOTAGE_ROOT?.trim()) {
      return NextResponse.json({ error: 'DRIVE_FOOTAGE_ROOT env var is not set' }, { status: 503 })
    }

    // 4. Compute paths (same shape for both clouds)
    const segments = buildStoragePath(booking.outlet.code, booking.bookingCode, camera, filename)
    const folderSegments = segments.slice(0, -1) // everything except the filename
    const wasabiKey = buildKey(getWasabiKeyPrefix(), segments)

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

    // 6. Drive — ensure folder path + reserve file slot + resumable session
    let driveTarget: { fileId: string; sessionUrl: string } | null = null
    try {
      const parentId = await ensureFolderPath(process.env.DRIVE_FOOTAGE_ROOT!.trim(), folderSegments)
      const driveSession = await createResumableUploadSession({
        parentFolderId: parentId,
        filename,
        mimeType,
        size,
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
        // Drive succeeded but Wasabi failed — DUAL_WRITE policy means
        // we must roll back Drive too. For now, mark FAILED and let the
        // operator cancel; reconciler will clean up.
        await prisma.upload.update({
          where: { id: upload.id },
          data: { status: 'FAILED', failureReason: `Wasabi init: ${e?.message || String(e)}` },
        })
        return NextResponse.json({ error: `Failed to initiate Wasabi upload: ${e?.message || e}` }, { status: 502 })
      }
    }

    return NextResponse.json({
      uploadId: upload.id,
      bookingCode: booking.bookingCode,
      outletFolder: outletFolderName(booking.outlet.code),
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
