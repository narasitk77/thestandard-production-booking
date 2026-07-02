import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { completeMultipart, verifyUpload, type CompletePart } from '@/lib/wasabi'
import { getDriveFile } from '@/lib/google-drive'
import { appendFootageRows } from '@/lib/footage-sheet'
import { clearFootageCache } from '@/lib/footage-folders'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload/complete
 *
 * Called by the browser after both clouds finish receiving bytes. We:
 *   1. CompleteMultipartUpload on Wasabi (if it was a target)
 *   2. HEAD verify Wasabi object size matches Upload.fileSize
 *   3. files.get on Drive to confirm the resumable PUT actually finished
 *   4. Flip Upload.status to COMPLETE (or DRIVE_OK / WASABI_OK on partial)
 *   5. Mark FootageLog.sheetRowWritten=true + append the footage sheet row
 *
 * Request body:
 *   {
 *     uploadId: string,
 *     drive?: { fileId: string },           // present if Drive was a target
 *     wasabi?: { parts: [{n, etag}] }       // present if Wasabi was a target
 *   }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const uploadId = String(body.uploadId || '').trim()
    if (!uploadId) return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })

    const upload = await prisma.upload.findUnique({
      where: { id: uploadId },
      include: {
        booking: {
          select: {
            id: true,
            bookingCode: true,
            outlet: { select: { code: true, name: true, storagePolicy: true } },
            program: { select: { code: true, name: true } },
          },
        },
      },
    })
    if (!upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
    if (upload.uploadedBy !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (upload.status === 'COMPLETE') {
      // Idempotent re-call — return current state without re-doing the work
      return NextResponse.json({ ok: true, upload: serialize(upload), idempotent: true })
    }

    const expectedSize = upload.fileSize != null ? Number(upload.fileSize) : 0
    const errors: string[] = []
    // v1.92.2 — flips true for failures that re-calling /complete could still fix
    // (metadata/propagation lag). When it stays false on a FAILED result, the
    // failure is deterministic (size mismatch, wrong target) → client stops retrying.
    let hasTransient = false

    // 1. Drive verify (if the upload targeted Drive)
    let driveOk = false
    let driveUrl: string | null = null
    if (upload.driveFileId) {
      const fileId = body.drive?.fileId ? String(body.drive.fileId) : upload.driveFileId
      if (fileId !== upload.driveFileId) {
        errors.push(`Drive fileId mismatch: row has ${upload.driveFileId}, request gave ${fileId}`)
      } else {
        const info = await getDriveFile(fileId)
        if (!info) {
          // v1.92.2 — TRANSIENT: Drive metadata can lag right after a large
          // upload; retrying /complete often resolves it (don't fail permanently).
          errors.push(`Drive file ${fileId} not readable (upload may have failed)`)
          hasTransient = true
        } else if (expectedSize > 0 && info.size != null && info.size !== expectedSize) {
          errors.push(`Drive size mismatch: expected ${expectedSize}, got ${info.size}`)
        } else {
          driveOk = true
          driveUrl = info.webViewLink
        }
      }
    }

    // 2. Wasabi complete + verify
    let wasabiOk = false
    if (upload.wasabiMultipartId && upload.wasabiKey) {
      const reqParts = Array.isArray(body.wasabi?.parts) ? body.wasabi.parts : null
      if (!reqParts || reqParts.length === 0) {
        errors.push('Wasabi parts missing from request body — cannot complete multipart upload')
      } else {
        const parts: CompletePart[] = reqParts.map((p: any) => ({
          partNumber: Number(p.n ?? p.partNumber),
          etag: String(p.etag || '').trim(),
        }))
        try {
          const res = await completeMultipart(upload.wasabiKey, upload.wasabiMultipartId, parts)
          // Server-side HEAD to sanity-check size matches
          const verifyOn = (process.env.WASABI_VERIFY_ON_COMPLETE ?? '1') !== '0'
          let verifyEtag = res.etag
          if (verifyOn && expectedSize > 0) {
            const verify = await verifyUpload(upload.wasabiKey, expectedSize)
            if (!verify.ok) {
              errors.push(`Wasabi verify: ${verify.reason}`)
              hasTransient = true // object propagation can lag — retry may resolve
            } else {
              verifyEtag = verify.etag ?? verifyEtag
              wasabiOk = true
            }
          } else {
            wasabiOk = true
          }
          if (wasabiOk) {
            await prisma.upload.update({
              where: { id: upload.id },
              data: { wasabiEtag: verifyEtag ?? null },
            })
          }
        } catch (e: any) {
          errors.push(`Wasabi CompleteMultipartUpload: ${e?.message || e}`)
          hasTransient = true // S3 5xx / network — safe to retry
        }
      }
    }

    // 3. Decide final status
    const driveExpected = !!upload.driveFileId
    const wasabiExpected = !!upload.wasabiMultipartId
    let finalStatus: 'COMPLETE' | 'DRIVE_OK' | 'WASABI_OK' | 'FAILED'
    if (driveExpected && wasabiExpected) {
      if (driveOk && wasabiOk) finalStatus = 'COMPLETE'
      else if (driveOk) finalStatus = 'DRIVE_OK'
      else if (wasabiOk) finalStatus = 'WASABI_OK'
      else finalStatus = 'FAILED'
    } else if (driveExpected) {
      finalStatus = driveOk ? 'COMPLETE' : 'FAILED'
    } else if (wasabiExpected) {
      finalStatus = wasabiOk ? 'COMPLETE' : 'FAILED'
    } else {
      finalStatus = 'FAILED'
      errors.push('No upload targets recorded on this Upload row')
    }

    const updated = await prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: finalStatus,
        driveUrl: driveUrl ?? upload.driveUrl,
        completedAt: finalStatus === 'COMPLETE' ? new Date() : null,
        failureReason: errors.length > 0 ? errors.join(' · ') : null,
      },
    })

    // 4. Sheet row + FootageLog flip — only on full success
    if (finalStatus === 'COMPLETE' && upload.driveFileId && upload.booking.bookingCode) {
      try {
        await appendFootageRows([{
          productionId: upload.booking.bookingCode,
          filename: upload.fileName,
          camera: upload.camera,
          uploader: upload.uploadedBy,
          timestamp: new Date(),
          driveLink: driveUrl,
          driveFileId: upload.driveFileId,
          bookingStatus: 'matched',
          outletName: upload.booking.outlet.name,
          programName: upload.booking.program.name,
        }])
        await prisma.footageLog.update({
          where: { driveFileId: upload.driveFileId },
          data: { sheetRowWritten: true, driveUrl },
        })
      } catch (e: any) {
        console.error('[upload/complete] sheet append failed (non-fatal):', e?.message || e)
        // Don't flip status back — file is safely in clouds, sheet row will
        // be picked up by the next footage scanner tick.
      }
    }

    // v1.111 — a new file landed in the box → invalidate the detect-footage cache
    // so the next scan (and notify-ready) reflect it. Awaited so the invalidation
    // is durable before we respond (clearFootageCache swallows its own errors).
    if (finalStatus === 'COMPLETE') await clearFootageCache(upload.booking.id)

    return NextResponse.json({
      ok: finalStatus === 'COMPLETE',
      status: finalStatus,
      // v1.92.2 — a FAILED result with no transient error is deterministic
      // (wrong size/target) → the client should stop retrying immediately.
      permanent: finalStatus === 'FAILED' && errors.length > 0 && !hasTransient,
      upload: serialize(updated),
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (e: any) {
    console.error('POST /api/upload/complete error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}

// Prisma Upload uses BigInt for fileSize → JSON can't serialize that natively.
function serialize(u: any) {
  return {
    ...u,
    fileSize: u.fileSize != null ? Number(u.fileSize) : null,
  }
}
