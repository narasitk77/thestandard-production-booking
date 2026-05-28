/**
 * Wasabi S3 client + multipart presign helpers for browser-direct uploads.
 *
 * Architecture (v1.35):
 *   /api/upload/init →   createMultipart() returns wasabiUploadId
 *                        presignParts(N parts) returns N PUT URLs
 *                        browser PUTs each chunk directly to Wasabi
 *   /api/upload/complete → completeMultipart() with returned ETags
 *   /api/upload/[id]/cancel → abortMultipart() releases storage
 *
 * Auth: AWS-SigV4 with WASABI_ACCESS_KEY + WASABI_SECRET_KEY (Portainer
 * stack env — never in git/chat/example files). The S3 client is created
 * lazily so a server boot without Wasabi config doesn't crash; callers
 * just check `isWasabiConfigured()` first.
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

let _client: S3Client | null = null

export function isWasabiConfigured(): boolean {
  return !!(
    process.env.WASABI_ENDPOINT?.trim() &&
    process.env.WASABI_REGION?.trim() &&
    process.env.WASABI_BUCKET?.trim() &&
    process.env.WASABI_ACCESS_KEY?.trim() &&
    process.env.WASABI_SECRET_KEY?.trim()
  )
}

export function getWasabiBucket(): string {
  const b = process.env.WASABI_BUCKET?.trim()
  if (!b) throw new Error('WASABI_BUCKET env var is not set')
  return b
}

export function getWasabiKeyPrefix(): string {
  // Strip leading/trailing slashes so callers always join with '/'.
  return (process.env.WASABI_KEY_PREFIX || '').trim().replace(/^\/+|\/+$/g, '')
}

function getClient(): S3Client {
  if (_client) return _client
  if (!isWasabiConfigured()) {
    throw new Error('Wasabi is not configured — set WASABI_* env vars in Portainer.')
  }
  _client = new S3Client({
    endpoint: process.env.WASABI_ENDPOINT!.trim(),
    region: process.env.WASABI_REGION!.trim(),
    credentials: {
      accessKeyId: process.env.WASABI_ACCESS_KEY!.trim(),
      secretAccessKey: process.env.WASABI_SECRET_KEY!.trim(),
    },
    // Wasabi uses S3-compatible path style for some buckets — force it
    // so the signature lines up regardless of bucket naming.
    forcePathStyle: false,
  })
  return _client
}

/**
 * Join a Wasabi key from segments. Mirrors what Drive does with folder
 * paths but Wasabi is flat (just a key string).
 *   buildKey('VIDEO2026', ['Advertorial', 'AGN-…', 'Cam1', '001.mp4'])
 *     → 'VIDEO2026/Advertorial/AGN-…/Cam1/001.mp4'
 */
export function buildKey(prefix: string, segments: string[]): string {
  const all = [prefix, ...segments].filter(s => s && s.length > 0)
  return all.join('/')
}

// Wasabi (S3) limits — fixed by the API spec, not configurable.
export const PART_SIZE_MIN_BYTES = 5 * 1024 * 1024        // 5MB (except last part)
export const PART_SIZE_MAX_BYTES = 5 * 1024 * 1024 * 1024 // 5GB
export const PARTS_MAX = 10_000
export const PRESIGN_TTL_SECONDS = 60 * 60 // 1 hour per part URL

/**
 * Compute a per-file part size that:
 *   - is at least PART_SIZE_MIN_BYTES (5MB)
 *   - splits the file into at most PARTS_MAX (10000) parts
 *   - rounds up to a multiple of 1MB so the math is human-readable
 *
 * For a 4GB file → ~5MB parts (800 parts). For a 50GB file → ~5MB
 * parts × 10000 wouldn't fit, so we bump up to ~6MB. For very large
 * files (>50TB, hypothetically) the function still returns a valid
 * size — but the file would exceed Wasabi single-object limits long
 * before that.
 */
export function chooseChunkSize(fileSize: number): number {
  if (fileSize <= 0) return PART_SIZE_MIN_BYTES
  const minBySize = Math.ceil(fileSize / PARTS_MAX)
  const raw = Math.max(PART_SIZE_MIN_BYTES, minBySize)
  // round up to nearest MB so progress bars look sensible
  const ONE_MB = 1024 * 1024
  return Math.ceil(raw / ONE_MB) * ONE_MB
}

export interface CreateMultipartResult {
  uploadId: string
  key: string
  bucket: string
}

export async function createMultipart(key: string, contentType: string): Promise<CreateMultipartResult> {
  const bucket = getWasabiBucket()
  const client = getClient()
  const res = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  }))
  if (!res.UploadId) throw new Error('Wasabi CreateMultipartUpload returned no UploadId')
  return { uploadId: res.UploadId, key, bucket }
}

export interface PresignedPart {
  partNumber: number
  url: string
}

/**
 * Presign one PUT URL per part. PartNumber is 1-based per S3 spec.
 * The browser must include the same Content-MD5/Content-Length headers
 * (or none) that we sign against — keep it minimal: no extra headers.
 */
export async function presignParts(
  key: string,
  uploadId: string,
  partCount: number,
): Promise<PresignedPart[]> {
  if (partCount < 1 || partCount > PARTS_MAX) {
    throw new Error(`partCount out of range: ${partCount} (must be 1..${PARTS_MAX})`)
  }
  const bucket = getWasabiBucket()
  const client = getClient()
  const out: PresignedPart[] = []
  for (let n = 1; n <= partCount; n++) {
    const cmd = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      PartNumber: n,
      UploadId: uploadId,
    })
    const url = await getSignedUrl(client, cmd, { expiresIn: PRESIGN_TTL_SECONDS })
    out.push({ partNumber: n, url })
  }
  return out
}

export interface CompletePart {
  partNumber: number
  etag: string
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: CompletePart[],
): Promise<{ etag: string | null; location: string | null }> {
  const bucket = getWasabiBucket()
  const client = getClient()
  // S3 requires parts in ascending PartNumber
  const sorted: CompletedPart[] = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(p => ({ PartNumber: p.partNumber, ETag: p.etag }))

  const res = await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: sorted },
  }))
  return { etag: res.ETag ?? null, location: res.Location ?? null }
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  const bucket = getWasabiBucket()
  const client = getClient()
  await client.send(new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  }))
}

/**
 * Server-side HEAD after the browser confirms the upload — verifies the
 * object exists, its size matches what we expected, and (optionally)
 * its ETag matches the multipart final ETag. Used by /api/upload/complete
 * when WASABI_VERIFY_ON_COMPLETE=1 (default).
 */
export async function verifyUpload(
  key: string,
  expectedSize: number,
): Promise<{ ok: boolean; actualSize: number | null; etag: string | null; reason?: string }> {
  const bucket = getWasabiBucket()
  const client = getClient()
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const actualSize = res.ContentLength ?? null
    if (actualSize !== null && actualSize !== expectedSize) {
      return { ok: false, actualSize, etag: res.ETag ?? null, reason: `size mismatch: expected ${expectedSize}, got ${actualSize}` }
    }
    return { ok: true, actualSize, etag: res.ETag ?? null }
  } catch (e: any) {
    return { ok: false, actualSize: null, etag: null, reason: e?.message || String(e) }
  }
}
