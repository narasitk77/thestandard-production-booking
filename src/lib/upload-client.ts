/**
 * Browser-side upload helpers used by `UploadSection`. Lives outside the
 * component so the retry + chunking logic is testable + readable in
 * isolation.
 *
 * Two flows, both designed to survive a real network on real footage
 * (4GB+ files over apartment wifi):
 *
 * 1. `uploadToDrive(sessionUrl, file, onProgress)`
 *    Chunked resumable PUT — 8MB chunks with Content-Range. Each chunk
 *    retried up to 4 times with exponential backoff. Drive returns
 *    308 between chunks; 200/201 on the final chunk.
 *
 * 2. `uploadToWasabi(file, parts, chunkSize, onProgress)`
 *    Multipart PUT — 4 chunks concurrently, each with up to 4 retries.
 *    Returns ETags for the server's CompleteMultipartUpload call.
 *
 * Both surface `onProgress(fraction, retryStatus?)` so the UI can show
 * a "retrying (2/4)" hint without a separate channel.
 */

export interface RetryStatus {
  attempt: number       // 1..maxAttempts
  maxAttempts: number
  lastError: string | null
  /** Closes back to null when the attempt succeeds. */
  active: boolean
}

export interface UploadCallbacks {
  onProgress: (fraction: number) => void
  onRetry?: (status: RetryStatus) => void
}

// ──────────────────────────────────────────────────────────────────────────────
// Finalize — POST /api/upload/complete, surviving transient failures
// ──────────────────────────────────────────────────────────────────────────────

// v1.83 — by the time we call /complete the footage bytes are already in
// Drive/Wasabi, so a momentary blip here (a deploy restart → 502, a non-JSON
// error page, a network drop) must NOT mark a finished upload as failed.
// /complete is idempotent (a re-call on an already-COMPLETE row returns ok), so
// retrying is safe. A 4xx is a real, permanent error (auth/validation) →
// surfaced immediately, not retried.
export const COMPLETE_MAX_ATTEMPTS = 10

export async function completeWithRetry(
  payload: any,
  opts: { fetchImpl?: typeof fetch; sleepMs?: (ms: number) => Promise<void> } = {},
): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch
  const sleepFor = opts.sleepMs ?? sleep
  let lastErr = 'complete failed'
  for (let attempt = 1; attempt <= COMPLETE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status >= 400 && res.status < 500) {
        const d = await res.json().catch(() => ({}))
        const err: any = new Error(d.error || d.errors?.join(' · ') || `complete failed (${res.status})`)
        err.permanent = true // auth/validation — retrying won't help
        throw err
      }
      if (res.ok) {
        const d = await res.json().catch(() => null)
        if (d?.ok) return d
        lastErr = d?.error || d?.errors?.join(' · ') || 'complete returned not-ok'
      } else {
        lastErr = `complete HTTP ${res.status}` // 5xx → transient, retry
      }
    } catch (e: any) {
      if (e?.permanent) throw e // permanent 4xx — surface immediately
      lastErr = e?.message || String(e) // fetch threw (network/JSON parse) → transient
    }
    if (attempt < COMPLETE_MAX_ATTEMPTS) await sleepFor(Math.min(20_000, 2000 * 2 ** (attempt - 1)))
  }
  throw new Error(`ปิดงานไม่สำเร็จหลังลองใหม่ ${COMPLETE_MAX_ATTEMPTS} ครั้ง: ${lastErr} — ไฟล์อาจขึ้น Drive แล้ว กด Refresh เพื่อตรวจสอบ`)
}

// ──────────────────────────────────────────────────────────────────────────────
// Drive — chunked resumable upload
// ──────────────────────────────────────────────────────────────────────────────

// Drive recommends chunk sizes that are multiples of 256KB and at most
// a few MB. 8MB is a good balance for big files (fewer round-trips) and
// recovery (small enough to retry quickly).
export const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024

const MAX_RETRIES = 4
const RETRY_BASE_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function backoffDelay(attempt: number): number {
  // 1.5s, 3s, 6s, 12s — capped at 20s. Jitter to avoid sync retries.
  const base = Math.min(20_000, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
  const jitter = Math.random() * 400
  return base + jitter
}

async function putChunkOnce(opts: {
  url: string
  body: Blob | ArrayBuffer
  headers?: Record<string, string>
  onChunkProgress?: (chunkBytes: number) => void
}): Promise<{ status: number; etag: string | null; rangeHeader: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', opts.url, true)
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      xhr.setRequestHeader(k, v)
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onChunkProgress) opts.onChunkProgress(e.loaded)
    }
    xhr.onload = () => {
      resolve({
        status: xhr.status,
        etag: (xhr.getResponseHeader('ETag') || '').replace(/"/g, '') || null,
        rangeHeader: xhr.getResponseHeader('Range'),
      })
    }
    xhr.onerror = () => reject(new Error('network error'))
    xhr.onabort = () => reject(new Error('aborted'))
    xhr.send(opts.body as any)
  })
}

async function putChunkWithRetry(opts: {
  url: string
  body: Blob | ArrayBuffer
  headers?: Record<string, string>
  onChunkProgress?: (chunkBytes: number) => void
  acceptStatuses: number[]    // statuses that count as success (Drive: 308 between chunks; Wasabi: 200)
  callbacks?: UploadCallbacks
  label: string               // for retry status messages
}): Promise<{ status: number; etag: string | null; rangeHeader: string | null }> {
  let lastError: string | null = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await putChunkOnce({
        url: opts.url,
        body: opts.body,
        headers: opts.headers,
        onChunkProgress: opts.onChunkProgress,
      })
      // Success status check — anything outside accepted retries
      if (opts.acceptStatuses.includes(result.status)) {
        // Clear any active retry hint
        if (attempt > 1) {
          opts.callbacks?.onRetry?.({
            attempt, maxAttempts: MAX_RETRIES, lastError: null, active: false,
          })
        }
        return result
      }
      // Non-success status — surface it and retry
      lastError = `${opts.label} HTTP ${result.status}`
      // 4xx (other than 408 timeout / 429 rate-limit) are usually not
      // transient — fail fast.
      if (result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429) {
        throw new Error(lastError)
      }
    } catch (e: any) {
      lastError = e?.message || String(e)
      if (lastError === 'aborted') throw e  // user-initiated, don't retry
    }
    if (attempt < MAX_RETRIES) {
      opts.callbacks?.onRetry?.({
        attempt: attempt + 1, maxAttempts: MAX_RETRIES, lastError, active: true,
      })
      await sleep(backoffDelay(attempt))
    }
  }
  throw new Error(`${opts.label} failed after ${MAX_RETRIES} attempts: ${lastError}`)
}

export async function uploadToDrive(
  sessionUrl: string,
  file: File,
  callbacks: UploadCallbacks,
): Promise<void> {
  const total = file.size
  let cursor = 0

  while (cursor < total) {
    const end = Math.min(cursor + DRIVE_CHUNK_SIZE, total)
    const chunk = file.slice(cursor, end)
    const range = `bytes ${cursor}-${end - 1}/${total}`
    const isFinal = end === total
    const startAtChunk = cursor

    const result = await putChunkWithRetry({
      url: sessionUrl,
      body: chunk,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Range': range,
      },
      // Drive returns 308 for intermediate chunks, 200/201 for the last.
      acceptStatuses: isFinal ? [200, 201] : [308, 200, 201],
      onChunkProgress: (chunkBytes) => {
        const totalLoaded = startAtChunk + chunkBytes
        callbacks.onProgress(Math.min(1, totalLoaded / total))
      },
      callbacks,
      label: 'Drive chunk',
    })

    cursor = end
    // v1.35.9 — defensive Range-header parsing. Drive may reply with
    // `Range: bytes=0-<n>` meaning "I have bytes 0 through n inclusive".
    // The strict semantics is that n+1 == nextByteToSend.
    //
    // Pre-v1.35.9 just trusted the header. Two failure modes that
    // motivated the tightening:
    //   1. Malformed/missing header → leave cursor at `end` (we just
    //      sent up to `end`, so that's the safe default).
    //   2. Header claims FEWER bytes received than we sent (n+1 < end
    //      = the value we'd have used) → REWIND cursor so the next PUT
    //      re-covers bytes n+1..end-1. Otherwise those bytes would be
    //      silently missing from the final file.
    //   3. Header claims MORE bytes received than physically possible
    //      (n+1 > end OR n+1 > total) → ignore (likely a malformed
    //      response or upstream proxy quirk) and keep cursor at end.
    if (!isFinal && result.rangeHeader) {
      const m = result.rangeHeader.match(/bytes=0-(\d+)/)
      if (m) {
        const drivesNextByte = Number(m[1]) + 1
        if (Number.isFinite(drivesNextByte) && drivesNextByte > 0 && drivesNextByte <= total) {
          if (drivesNextByte < cursor) {
            // Drive received less than we sent — rewind so the next PUT
            // re-covers the gap. Without this, bytes [drivesNextByte..end)
            // would be missing from the final Drive file.
            console.warn(`[upload-client] Drive Range header reports fewer bytes received (${drivesNextByte}) than we sent (${cursor}); rewinding cursor to avoid silent data loss`)
            cursor = drivesNextByte
          }
          // drivesNextByte === cursor: nothing to do.
          // drivesNextByte > cursor: Drive claims it received MORE bytes
          // than we know we sent. Ignore — likely an upstream proxy or
          // header quirk. Trusting it would mean SKIPPING bytes.
        }
      }
    }
  }
  callbacks.onProgress(1)
}

// ──────────────────────────────────────────────────────────────────────────────
// Wasabi — multipart upload with parallel parts + per-part retry
// ──────────────────────────────────────────────────────────────────────────────

const WASABI_CONCURRENCY = 4

export async function uploadToWasabi(
  file: File,
  parts: Array<{ partNumber: number; url: string }>,
  chunkSize: number,
  callbacks: UploadCallbacks,
): Promise<Array<{ n: number; etag: string }>> {
  const total = file.size
  const loaded = new Array<number>(parts.length).fill(0)
  const out: Array<{ n: number; etag: string }> = new Array(parts.length)
  let cursor = 0
  let active = 0
  let failed = false
  let failedReason: any = null

  return new Promise<Array<{ n: number; etag: string }>>((resolve, reject) => {
    const emitProgress = () => {
      const sum = loaded.reduce((a, b) => a + b, 0)
      callbacks.onProgress(Math.min(1, sum / total))
    }

    const settle = () => {
      if (failed) reject(failedReason)
      else if (cursor >= parts.length && active === 0) {
        callbacks.onProgress(1)
        resolve(out.filter(Boolean))
      }
    }

    const startNext = () => {
      if (failed) { settle(); return }
      while (active < WASABI_CONCURRENCY && cursor < parts.length) {
        const idx = cursor++
        const part = parts[idx]
        const start = idx * chunkSize
        const end = Math.min(start + chunkSize, file.size)
        const chunk = file.slice(start, end)
        active++

        putChunkWithRetry({
          url: part.url,
          body: chunk,
          // No extra headers — pre-signed URLs sign without them
          acceptStatuses: [200],
          onChunkProgress: (chunkBytes) => {
            loaded[idx] = chunkBytes
            emitProgress()
          },
          callbacks,
          label: `Wasabi part ${part.partNumber}`,
        }).then(result => {
          out[idx] = { n: part.partNumber, etag: result.etag ?? '' }
          loaded[idx] = end - start
          emitProgress()
          active--
          startNext()
          if (cursor >= parts.length && active === 0) settle()
        }).catch(err => {
          if (!failed) { failed = true; failedReason = err }
          active--
          settle()
        })
      }
      if (cursor >= parts.length && active === 0) settle()
    }
    startNext()
  })
}
