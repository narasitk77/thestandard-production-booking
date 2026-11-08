// Automated Postgres backup → Google Drive. Runs inside the app container
// (has DATABASE_URL + Drive service-account creds + pg_dump from the image's
// postgresql-client). Poked daily by scripts/backup-worker.js. This is the
// system's only recovery path, so it's deliberately simple and self-contained.
import { spawn } from 'child_process'
import { createGzip } from 'zlib'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { getDriveWriteAuth, uploadFileToFolder, trashDriveItem } from './google-drive'

function posInt(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? n : fallback
}

/** Run pg_dump, gzip the stream in-process, and resolve the compressed bytes. */
function dumpGzipped(databaseUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', databaseUrl])
    const gzip = createGzip()
    const chunks: Buffer[] = []
    let stderr = ''
    dump.stderr.on('data', (d) => { stderr += d.toString() })
    dump.on('error', (e) => reject(new Error(`pg_dump spawn failed: ${e.message}`)))
    dump.on('close', (code) => {
      if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`))
    })
    gzip.on('data', (c) => chunks.push(c as Buffer))
    gzip.on('error', reject)
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    dump.stdout.pipe(gzip)
  })
}

/**
 * Prune: move backups older than retentionDays to Drive trash.
 *
 * 2026-11-08 — three fixes: (1) follow nextPageToken — a 365-day retention with a
 * backup on every boot + every deploy.py + daily passes 1000 files within a year
 * and page 2+ was never looked at; (2) count only what actually got trashed — a
 * failure used to `.catch(() => {})` and still `removed++`; (3) trash, not
 * files.delete — HANDOVER: no permanent delete in this codebase (trash = ~30 days
 * to recover). Failures are reported, never thrown: the backup itself succeeded.
 */
export async function pruneBackups(folderId: string, retentionDays: number): Promise<{ removed: number; failed: number }> {
  if (retentionDays <= 0) return { removed: 0, failed: 0 }
  const drive = google.drive({ version: 'v3', auth: getDriveWriteAuth() })
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000
  const old: { id: string; name: string }[] = []
  let pageToken: string | undefined
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and name contains 'backup-'`,
      fields: 'nextPageToken, files(id, name, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    for (const f of res.data.files || []) {
      if (f.id && f.createdTime && new Date(f.createdTime).getTime() < cutoff) old.push({ id: f.id, name: f.name || f.id })
    }
    pageToken = res.data.nextPageToken || undefined
  } while (pageToken)

  let removed = 0
  const failures: string[] = []
  for (const f of old) {
    try {
      await trashDriveItem(f.id)
      removed++
    } catch (e: any) {
      failures.push(`${f.name}: ${e?.message || e}`)
    }
  }
  if (failures.length) {
    console.error(`[backup] prune run failed: ${failures.length}/${old.length} old backup(s) not trashed (backup itself OK) — ${failures[0]}`)
  }
  return { removed, failed: failures.length }
}

/** pruneFailed: old backups that could not be trashed · -1 = could not even list the folder */
export interface BackupResult { fileName: string; sizeBytes: number; driveFileId: string; pruned: number; pruneFailed: number }

/** Take a full DB backup and upload it to the configured Drive folder. */
export async function runBackup(): Promise<BackupResult> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL not set')
  const folderId = process.env.BACKUP_DRIVE_FOLDER_ID?.trim()
  if (!folderId) throw new Error('BACKUP_DRIVE_FOLDER_ID not set (Drive folder for DB backups)')

  const gz = await dumpGzipped(databaseUrl)
  if (gz.length === 0) throw new Error('pg_dump produced an empty file')

  // backup-2026-06-19T0930.sql.gz (UTC, colon-free for Drive/file names)
  const stamp = new Date().toISOString().replace(/:/g, '').replace(/\..+$/, '').replace('T', 'T')
  const fileName = `backup-${stamp}.sql.gz`
  const up = await uploadFileToFolder({ parentFolderId: folderId, filename: fileName, mimeType: 'application/gzip', body: Readable.from(gz) })
  const pr = await pruneBackups(folderId, posInt(process.env.BACKUP_RETENTION_DAYS, 30)).catch((e: any) => {
    // listing failed — say so (the old `.catch(() => 0)` read as "nothing to prune")
    console.error('[backup] prune run failed (backup itself OK):', e?.message || e)
    return { removed: 0, failed: -1 }
  })
  return { fileName, sizeBytes: gz.length, driveFileId: up.id, pruned: pr.removed, pruneFailed: pr.failed }
}
