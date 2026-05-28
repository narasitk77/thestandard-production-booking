import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { isWasabiConfigured, getWasabiBucket, getWasabiKeyPrefix } from '@/lib/wasabi'
import { hasDriveCredentials } from '@/lib/google-drive'
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/upload-config
 *
 * Admin-only diagnostic for the v1.35.x dual-cloud upload stack.
 * Returns:
 *   - Which env vars are present (NOT the values — only "set" / "missing")
 *   - Whether Wasabi credentials actually authenticate (HeadBucket call)
 *   - Whether Drive credentials look configured (no live check — saves
 *     a DWD round-trip; the upload init endpoint surfaces real errors)
 *
 * Used to verify a fresh deploy without having to attempt a real upload.
 * Run in browser: https://probook.xtec9.xyz/api/admin/upload-config
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const present = (v: string | undefined | null) => (v && v.trim()) ? 'set' : 'MISSING'
  const config = {
    wasabi: {
      endpoint: present(process.env.WASABI_ENDPOINT),
      region: present(process.env.WASABI_REGION),
      bucket: present(process.env.WASABI_BUCKET),
      keyPrefix: present(process.env.WASABI_KEY_PREFIX),
      accessKey: present(process.env.WASABI_ACCESS_KEY),
      secretKey: present(process.env.WASABI_SECRET_KEY),
      verifyOnComplete: process.env.WASABI_VERIFY_ON_COMPLETE ?? '1',
      isConfigured: isWasabiConfigured(),
      bucketValue: isWasabiConfigured() ? getWasabiBucket() : null,
      keyPrefixValue: isWasabiConfigured() ? getWasabiKeyPrefix() : null,
    },
    drive: {
      hasCredentials: hasDriveCredentials(),
      impersonateSubject: process.env.GOOGLE_IMPERSONATE_SUBJECT?.trim() ?? '(default)',
      footageRoot: process.env.DRIVE_FOOTAGE_ROOT?.trim() ?? null,
    },
    footage: {
      sheetId: process.env.FOOTAGE_LOG_SHEET_ID?.trim() ? 'set' : 'MISSING',
      sheetTab: process.env.FOOTAGE_LOG_TAB?.trim() ?? '(default Sheet1)',
      workerEnabled: process.env.FOOTAGE_WORKER_ENABLED ?? '0',
      workerIntervalMs: process.env.FOOTAGE_WORKER_INTERVAL_MS ?? '(default 600000)',
    },
  }

  // Live check: do Wasabi credentials actually authenticate? Tiny HEAD
  // request — returns 200 if the bucket exists and we have any access,
  // 403/404 with a clear message otherwise.
  let wasabiPing: { ok: boolean; reason?: string; latencyMs?: number } = { ok: false, reason: 'not attempted' }
  if (isWasabiConfigured()) {
    const t0 = Date.now()
    try {
      const client = new S3Client({
        endpoint: process.env.WASABI_ENDPOINT!.trim(),
        region: process.env.WASABI_REGION!.trim(),
        credentials: {
          accessKeyId: process.env.WASABI_ACCESS_KEY!.trim(),
          secretAccessKey: process.env.WASABI_SECRET_KEY!.trim(),
        },
      })
      await client.send(new HeadBucketCommand({ Bucket: getWasabiBucket() }))
      wasabiPing = { ok: true, latencyMs: Date.now() - t0 }
    } catch (e: any) {
      wasabiPing = {
        ok: false,
        latencyMs: Date.now() - t0,
        reason: e?.name === 'NotFound'
          ? `Bucket "${getWasabiBucket()}" not found — check WASABI_BUCKET value`
          : e?.$metadata?.httpStatusCode === 403
            ? 'Authentication failed — check WASABI_ACCESS_KEY / WASABI_SECRET_KEY'
            : (e?.message || String(e)),
      }
    }
  }

  return NextResponse.json({
    config,
    wasabiPing,
    summary: {
      wasabiReady: config.wasabi.isConfigured && wasabiPing.ok,
      driveReady: config.drive.hasCredentials && !!config.drive.footageRoot,
      footageSheetReady: config.footage.sheetId === 'set',
    },
  })
}
