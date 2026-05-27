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

const DRIVE_READ_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

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

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  webViewLink: string | null
  size: number | null
  createdTime: string | null
  modifiedTime: string | null
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

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
  const queue: string[] = [rootFolderId]
  const visited = new Set<string>()

  while (queue.length > 0 && out.length < maxFiles) {
    const parentId = queue.shift()!
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
          queue.push(f.id)
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
