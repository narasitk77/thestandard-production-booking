/**
 * Google Drive read helpers — used by the footage-sheet sync worker
 * (v1.34.2) to walk a Shared Drive folder and discover new files.
 *
 * Auth: DWD-impersonated, matching `google-calendar.ts`'s pattern. The
 * impersonated user (default `narasit.k@thestandard.co` via
 * `getCalendarImpersonateSubject`) must have access to the Shared Drive
 * we're scanning. The service account alone cannot read a Shared Drive
 * the user owns — DWD is the mechanism the user picked over making the
 * SA a Content Manager directly.
 *
 * Scope: `drive.readonly` — we only LIST files. The worker never writes
 * to Drive. If a future feature needs to push files (e.g. /upload web
 * push), introduce a separate write-auth helper with the narrower
 * `drive.file` scope so the read path stays minimal.
 */

import { google, drive_v3 } from 'googleapis'
import { getCalendarImpersonateSubject } from './google-calendar'

// v1.36.0 — read path uses the SAME full `drive` scope as the write path.
// Domain-Wide Delegation authorizes scopes EXACTLY, not hierarchically: the
// Workspace Admin DWD grant for this service account lists `calendar` +
// `drive` only. Requesting `drive.readonly` (a different string) fails with
// `unauthorized_client`, which silently broke the footage worker + the
// inspect script. `drive` is a superset of read, so reads work and we don't
// need a second DWD scope. (If least-privilege read is ever wanted, add
// `drive.readonly` to the DWD grant and revert this line.)
const DRIVE_READ_SCOPES = ['https://www.googleapis.com/auth/drive']
// v1.35.1 — write scope for the booking upload path. Full `drive` scope
// because the impersonated user (narasit.k) is the Shared Drive Content
// Manager — `drive.file` would restrict to files THIS SDK invocation
// created, which would block listing/managing existing files later.
const DRIVE_WRITE_SCOPES = ['https://www.googleapis.com/auth/drive']

/**
 * JWT auth for Drive read. Impersonates the user configured for Calendar
 * (single source of truth — both APIs go through the same DWD grant).
 *
 * Throws when service account credentials are missing — callers should
 * defensively check `hasDriveCredentials()` if they want graceful
 * "Drive not configured" behavior (e.g. the worker logs once and idles).
 */
export function getDriveReadAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }
  const subject = getCalendarImpersonateSubject()
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: DRIVE_READ_SCOPES,
    subject,
  })
}

export function hasDriveCredentials(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY))
}

/**
 * Same DWD model as read, but with full `drive` scope so the upload
 * path can create folders + initiate resumable upload sessions.
 */
export function getDriveWriteAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }
  const subject = getCalendarImpersonateSubject()
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: DRIVE_WRITE_SCOPES,
    subject,
  })
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  webViewLink: string | null
  size: number | null
  createdTime: string | null
  modifiedTime: string | null
  /**
   * Names of all ancestor folders from the scan root → immediate parent,
   * collected as we walk the tree. Root folder itself is NOT included
   * (its name is meaningless to the Production ID match — we only care
   * about the structure underneath).
   *
   * Used by the footage sync to enforce the folder-only convention from
   * `episode-id.ts`: the Production ID lives on a *folder name*, not the
   * filename. So a file at `ROOT/2026-04/AGN-260423-EVT-01/Cam1/001.mp4`
   * has folderPath `['2026-04', 'AGN-260423-EVT-01', 'Cam1']` — the
   * matcher walks from the closest parent (`Cam1`) upward until it hits
   * a folder name that parses as a Production ID.
   */
  folderPath: string[]
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

// MIME types we explicitly skip when collecting files. Shortcuts point
// elsewhere (could double-count the target) and Google-native docs
// aren't media footage — both would just clutter the footage log.
// Defensive against accidents: someone drops a Google Doc with notes
// into a Production ID folder, the worker still skips it.
const SKIP_FILE_MIME = new Set([
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.drawing',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.fusiontable',
  'application/vnd.google-apps.jam',
])

/**
 * Recursively list every non-folder file under `rootFolderId`. Works on
 * both personal folders and Shared Drives (`supportsAllDrives` +
 * `includeItemsFromAllDrives`).
 *
 * Uses depth-first traversal with a worklist queue + a pageSize-1000
 * Drive.list per parent. For a folder containing ~10K files split across
 * many sub-folders this typically runs in a handful of round-trips.
 *
 * Soft cap: `maxFiles` (default 5000) — protects the worker process
 * from runaway memory on a misconfigured root. Hitting the cap logs a
 * warning; the worker can be re-tuned via env later.
 */
export async function listFilesRecursive(
  rootFolderId: string,
  opts: {
    maxFiles?: number
    /**
     * Optional ISO 8601 cutoff — return only files whose `modifiedTime`
     * is strictly greater than this value. Used by the worker to do
     * incremental scans after the first full pass.
     */
    modifiedAfter?: string
  } = {},
): Promise<DriveFile[]> {
  const maxFiles = opts.maxFiles ?? 5000
  const auth = getDriveReadAuth()
  const drive = google.drive({ version: 'v3', auth })

  const out: DriveFile[] = []
  // Walk queue carries the parent folder ID + the path of ancestor names
  // accumulated from the root downward (excluding the root itself).
  type WalkEntry = { folderId: string; path: string[] }
  const queue: WalkEntry[] = [{ folderId: rootFolderId, path: [] }]
  const visited = new Set<string>()

  while (queue.length > 0 && out.length < maxFiles) {
    const { folderId: parentId, path } = queue.shift()!
    if (visited.has(parentId)) continue
    visited.add(parentId)

    let pageToken: string | undefined = undefined
    do {
      const baseQ = `'${parentId}' in parents and trashed = false`
      const q = opts.modifiedAfter ? `${baseQ} and modifiedTime > '${opts.modifiedAfter}'` : baseQ

      const res: { data: drive_v3.Schema$FileList } = await drive.files.list({
        q,
        fields: 'nextPageToken, files(id, name, mimeType, parents, webViewLink, size, createdTime, modifiedTime)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      })

      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name || !f.mimeType) continue
        if (f.mimeType === FOLDER_MIME) {
          // Push child folder onto the queue with its name appended to the
          // accumulated path. We enqueue ONCE per folder (visited guard
          // catches the rare case where Drive returns a folder twice).
          queue.push({ folderId: f.id, path: [...path, f.name] })
        } else if (SKIP_FILE_MIME.has(f.mimeType)) {
          // Shortcuts + Google-native docs aren't real footage — skip.
          continue
        } else {
          out.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            parents: f.parents ?? [],
            webViewLink: f.webViewLink ?? null,
            size: f.size ? Number(f.size) : null,
            createdTime: f.createdTime ?? null,
            modifiedTime: f.modifiedTime ?? null,
            folderPath: path,
          })
          if (out.length >= maxFiles) break
        }
      }
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken && out.length < maxFiles)
  }

  if (out.length >= maxFiles) {
    console.warn(`[google-drive] listFilesRecursive hit maxFiles=${maxFiles} for root=${rootFolderId} — increase via worker config if expected.`)
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────────
// v1.35.1 — write helpers used by /api/upload/init to (a) make sure the
// destination folder exists in the Shared Drive and (b) hand the browser
// a resumable upload session URL it can stream bytes into directly.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Find or create a single child folder under `parentId`. Race-safe via
 * a list-then-create pattern: two concurrent calls might both create the
 * folder, but the second's create would succeed too and we'd just orphan
 * one empty folder — acceptable cost. To make it strictly atomic we'd
 * need Drive locks (it doesn't have them).
 */
async function ensureChildFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string> {
  // Escape single quotes in folder name for the query string
  const safeName = name.replace(/'/g, "\\'")
  const found = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and name = '${safeName}'`,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  })
  const existing = found.data.files?.[0]
  if (existing?.id) return existing.id

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!created.data.id) throw new Error(`Drive folder create returned no id for "${name}"`)
  return created.data.id
}

/**
 * Walk a path of folder names under `rootFolderId`, creating any segment
 * that's missing. Returns the leaf folder's id. Used by /api/upload/init
 * to ensure `<root>/<outlet>/<bookingCode>/<camera>/` exists before
 * starting the resumable upload session.
 *
 *   ensureFolderPath(root, ['Advertorial', 'AGN-260423-EVT-01', 'Cam1'])
 *     → id of the Cam1 folder (created on first call, reused after)
 */
export async function ensureFolderPath(
  rootFolderId: string,
  segments: string[],
): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  let parent = rootFolderId
  for (const segment of segments) {
    parent = await ensureChildFolder(drive, parent, segment)
  }
  return parent
}

/** Strip a leading ordering prefix like "9." / "10) " / "3 - " from a folder name. */
function stripOrderingPrefix(name: string): string {
  return name.replace(/^\s*\d+\s*[.)\-]\s*/, '').trim()
}

/**
 * v1.36.0 — find an EXISTING child folder whose name matches `canonicalName`
 * after its ordering prefix is stripped, so footage lands in the team's real
 * outlet folder (e.g. "9.ADVERTORIAL") instead of a freshly-created duplicate
 * ("ADVERTORIAL"). The producers re-number these folders over time, so we
 * match on the suffix, case-insensitively.
 *
 * A folder is a CANDIDATE when its name equals `canonicalName` after the
 * ordering prefix is stripped (this also covers bare, un-prefixed names,
 * since stripping a no-prefix name is a no-op). Among candidates we prefer
 * the one that carries a numeric prefix — that's the team's canonical
 * convention ("9.ADVERTORIAL"), so a stray un-numbered duplicate
 * ("ADVERTORIAL", e.g. created by an earlier bug) never wins. Lowest
 * number breaks ties. If no candidate exists we create a plain
 * `canonicalName` folder — a visible, correctable fallback rather than a
 * silent wrong-folder write.
 */
async function ensureChildFolderByCanonicalName(
  drive: drive_v3.Drive,
  parentId: string,
  canonicalName: string,
): Promise<string> {
  const want = canonicalName.trim().toLowerCase()
  // List all child folders under the parent (the root has ~17 — cheap).
  const children: Array<{ id: string; name: string }> = []
  let pageToken: string | undefined = undefined
  do {
    const res: { data: drive_v3.Schema$FileList } = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    })
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) children.push({ id: f.id, name: f.name })
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  // Candidates = name matches the canonical suffix (prefix-tolerant).
  const candidates = children.filter(
    f => stripOrderingPrefix(f.name).toLowerCase() === want,
  )
  if (candidates.length > 0) {
    // Prefer a numbered folder (team convention); lowest number first.
    const numbered = candidates
      .map(f => ({ f, n: parseInt(f.name.match(/^\s*(\d+)/)?.[1] ?? '', 10) }))
      .filter(x => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n)
    if (numbered.length > 0) return numbered[0].f.id
    return candidates[0].id // no numbered variant — take the bare match
  }

  // Fallback — create a plain canonical folder (surfaces the gap visibly).
  const created = await drive.files.create({
    requestBody: { name: canonicalName, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!created.data.id) throw new Error(`Drive folder create returned no id for "${canonicalName}"`)
  return created.data.id
}

export interface UploadFolderTarget {
  /** id of "<outlet>/<bookingFolder>/" — where booking-info.txt lives. */
  bookingFolderId: string
  /** id of "<outlet>/<bookingFolder>/<camera>/" — where the file goes. */
  cameraFolderId: string
}

/**
 * v1.36.0 — resolve (and create where needed) the Drive folder path for an
 * upload, reusing the team's existing outlet folder:
 *
 *   <root>/<existing outlet folder>/<bookingFolder>/<camera>/
 *
 * - outlet segment is matched fuzzily (ordering-prefix tolerant) so we land
 *   in "9.ADVERTORIAL" instead of making a new "ADVERTORIAL".
 * - bookingFolder + camera are our own naming → exact ensure/create.
 *
 * Returns both the booking-folder id (for the info .txt) and the camera-folder
 * id (for the file itself).
 */
export async function ensureUploadFolderPath(input: {
  rootFolderId: string
  outletCanonicalName: string
  bookingFolderName: string
  camera: string
}): Promise<UploadFolderTarget> {
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  const outletId = await ensureChildFolderByCanonicalName(drive, input.rootFolderId, input.outletCanonicalName)
  const bookingFolderId = await ensureChildFolder(drive, outletId, input.bookingFolderName)
  const cameraFolderId = await ensureChildFolder(drive, bookingFolderId, input.camera)
  return { bookingFolderId, cameraFolderId }
}

/**
 * v1.36.0 — write (or refresh) a small UTF-8 text file inside a folder.
 * Used to drop a `booking-info.txt` next to the footage so editors who open
 * the folder see the shoot's context without leaving Drive. Idempotent:
 * if a file of the same name already exists in the folder we UPDATE its
 * contents (keeps a single, current info file across re-assigns); otherwise
 * we create it. Best-effort by contract — callers should not fail the upload
 * if this throws.
 */
export async function upsertTextFile(input: {
  parentFolderId: string
  name: string
  content: string
}): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  const safeName = input.name.replace(/'/g, "\\'")
  const found = await drive.files.list({
    q: `'${input.parentFolderId}' in parents and trashed = false and name = '${safeName}'`,
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  })
  const media = { mimeType: 'text/plain', body: input.content }
  const existingId = found.data.files?.[0]?.id
  if (existingId) {
    await drive.files.update({ fileId: existingId, media, supportsAllDrives: true })
    return existingId
  }
  const created = await drive.files.create({
    requestBody: { name: input.name, mimeType: 'text/plain', parents: [input.parentFolderId] },
    media,
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!created.data.id) throw new Error(`Drive text-file create returned no id for "${input.name}"`)
  return created.data.id
}

export interface ResumableSession {
  /** Drive file id reserved for the upload (browser PUTs into this slot). */
  fileId: string
  /** Browser PUTs chunks (or one big blob) to this URL. */
  sessionUrl: string
}

/**
 * Initiate a resumable upload session by creating an empty file slot via
 * `files.create` and returning its `id` plus a session URL the browser
 * can stream bytes into. Two-step because Drive's resumable upload API
 * doesn't natively expose the session URL through the SDK — we reserve
 * the id with the SDK, then start a resumable session with a raw HTTP
 * POST that returns the session URL in the `Location` header.
 *
 * Browser flow:
 *   PUT {sessionUrl}
 *     Content-Length: <size>
 *     Content-Type: <mime>
 *     <bytes>
 *   → 200 OK with the final file metadata
 *
 * For chunked / resumable browser uploads, the browser PUTs each chunk
 * with a Content-Range header. The session URL stays valid for ~1 week
 * by default (Drive's contract).
 */
export async function createResumableUploadSession(input: {
  parentFolderId: string
  filename: string
  mimeType: string
  size: number
}): Promise<ResumableSession> {
  const auth = getDriveWriteAuth()
  // Get a fresh OAuth access token to hit the raw resumable endpoint.
  await auth.authorize()
  const accessToken = auth.credentials.access_token
  if (!accessToken) throw new Error('Drive write auth: no access token after authorize()')

  // Reserve the file id first via the SDK (gives us a stable id to track
  // before any bytes are uploaded — useful for FootageLog dedupe).
  const drive = google.drive({ version: 'v3', auth })
  const reserve = await drive.files.create({
    requestBody: {
      name: input.filename,
      parents: [input.parentFolderId],
      mimeType: input.mimeType || 'application/octet-stream',
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  const fileId = reserve.data.id
  if (!fileId) throw new Error('Drive resumable: files.create returned no id')

  // Now POST to the resumable upload endpoint, scoped to that file id,
  // to obtain the session URL. The body is empty (we're "updating" with
  // a resumable session, not the initial create).
  const initRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Upload-Content-Type': input.mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(input.size),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  )
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => '')
    throw new Error(`Drive resumable init failed: HTTP ${initRes.status} — ${body.slice(0, 300)}`)
  }
  const sessionUrl = initRes.headers.get('Location')
  if (!sessionUrl) throw new Error('Drive resumable init: no Location header in response')

  return { fileId, sessionUrl }
}

/**
 * Best-effort cleanup after a failed/cancelled upload. Removes the
 * reserved Drive file slot so an aborted session doesn't leave an
 * empty/partial file in the Shared Drive.
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  await drive.files.delete({ fileId, supportsAllDrives: true })
}

/**
 * Read the size + name of an uploaded Drive file. Used by
 * /api/upload/complete to confirm the upload actually finished (Drive's
 * resumable PUT can succeed partially, leaving a file shorter than
 * expected — checking size mirrors the Wasabi verifyUpload pattern).
 */
export async function getDriveFile(fileId: string): Promise<{
  id: string; name: string; size: number | null; webViewLink: string | null
} | null> {
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'id, name, size, webViewLink',
      supportsAllDrives: true,
    })
    return {
      id: res.data.id ?? fileId,
      name: res.data.name ?? '',
      size: res.data.size ? Number(res.data.size) : null,
      webViewLink: res.data.webViewLink ?? null,
    }
  } catch {
    return null
  }
}
