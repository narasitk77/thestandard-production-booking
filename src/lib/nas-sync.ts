/**
 * v1.111 — NAS ↔ Production Team (Drive landing) sync verification.
 *
 * The crew dumps footage on the office NAS; a sync tool mirrors it up to the
 * flat "Production Team" Shared Drive, and only THEN can the merge button move
 * it into the VIDEO 2026 box. Ops asked for: a button that verifies the two
 * sides match 100%, an email the moment a folder finishes syncing, and a daily
 * digest.
 *
 * The prod container can't see the NAS (it's an SMB mount on the admin's Mac),
 * so a tiny launchd agent on that Mac scans the mount every ~10 min and POSTs a
 * manifest here (scripts/nas-manifest-agent.sh). ingestNasManifest() stores it,
 * diffs against Drive, emails "✅ ซิงค์ครบ" on a folder's transition to
 * complete, and sends the daily digest at most once per 22h.
 */
import { prisma } from './db'
import { sendEmail, isEmailConfigured } from './email'
import { listChildFolders, listFilesRecursive } from './google-drive'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'
// Booking-info files live only on the Drive side — never count them as "extra".
const IGNORE_RE = /^_SHOOT\b.*\.txt$/i

export interface NasManifestFolder { name: string; files: Array<{ p: string; size: number }> }
export interface NasManifest { at: string; host?: string; folders: NasManifestFolder[] }

export interface FolderSyncReport {
  name: string
  nasFiles: number
  nasBytes: number
  driveMatched: number
  missingOnDrive: number
  missingSample: string[]
  complete: boolean
  driveFolderId: string | null
}

export interface NasSyncReport {
  nasAt: string | null
  comparedAt: string
  folders: FolderSyncReport[]
  completeCount: number
  totalFolders: number
}

/** Extract the Production ID from a folder name — "… (TSS-260702-01)" or leading code. */
function codeOf(name: string): string | null {
  const m = name.match(/\(([A-Z]{2,4}(?:-[A-Z0-9]+)*-\d{6}(?:-[A-Z0-9]+)*-?\d*)\)/) || name.match(/^([A-Z]{2,4}(?:-[A-Z0-9]+)*-\d{6}(?:-[A-Z0-9]+)*-?\d*)\b/)
  return m ? m[1] : null
}

/** Compare the stored NAS manifest against the Drive landing folders. */
export async function compareNasToDrive(manifest: NasManifest): Promise<NasSyncReport> {
  const driveChildren = await listChildFolders(PRODUCTION_TEAM_ROOT)
  const folders: FolderSyncReport[] = []

  for (const nf of manifest.folders) {
    const nasCode = codeOf(nf.name)
    // Match the Drive folder by Production ID first (names may lag a rename),
    // then by exact name.
    const drive = driveChildren.find(c => nasCode && codeOf(c.name) === nasCode)
      || driveChildren.find(c => c.name === nf.name)
      || null

    const nasBytes = nf.files.reduce((n, f) => n + (f.size || 0), 0)
    if (!drive) {
      folders.push({
        name: nf.name, nasFiles: nf.files.length, nasBytes,
        driveMatched: 0, missingOnDrive: nf.files.length,
        missingSample: nf.files.slice(0, 5).map(f => f.p),
        complete: nf.files.length === 0, driveFolderId: null,
      })
      continue
    }

    const driveFiles = (await listFilesRecursive(drive.id, { maxFiles: 6000 })).filter(f => !IGNORE_RE.test(f.name))
    // Key by relative path + size. Drive relative path = folderPath under the
    // scan root + name (mirrors how the NAS manifest builds its `p`).
    const driveSet = new Set(driveFiles.map(f => `${[...(f.folderPath || []), f.name].join('/')}|${f.size ?? ''}`))
    const missing = nf.files.filter(f => !driveSet.has(`${f.p}|${f.size}`))

    folders.push({
      name: nf.name,
      nasFiles: nf.files.length,
      nasBytes,
      driveMatched: nf.files.length - missing.length,
      missingOnDrive: missing.length,
      missingSample: missing.slice(0, 5).map(f => f.p),
      complete: missing.length === 0 && nf.files.length > 0,
      driveFolderId: drive.id,
    })
  }

  const completeCount = folders.filter(f => f.complete).length
  return { nasAt: manifest.at ?? null, comparedAt: new Date().toISOString(), folders, completeCount, totalFolders: folders.length }
}

const GB = 1024 ** 3
const fmtGB = (b: number) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`

function digestText(report: NasSyncReport): string {
  const lines = report.folders.map(f =>
    `${f.complete ? '✅' : f.missingOnDrive === f.nasFiles ? '⏳' : '🔄'} ${f.name}\n   NAS ${f.nasFiles} ไฟล์ (${fmtGB(f.nasBytes)}) · ขึ้น Drive แล้ว ${f.driveMatched}/${f.nasFiles}${f.missingOnDrive ? ` · ค้าง ${f.missingOnDrive}` : ''}`,
  )
  return `รายงานซิงค์ NAS ↔ Production Team (Drive)
ข้อมูล NAS ณ ${report.nasAt ? new Date(report.nasAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'}
ครบแล้ว ${report.completeCount}/${report.totalFolders} โฟลเดอร์

${lines.join('\n')}

— THE STANDARD Production Booking`
}

function reportEmailTo(): string | null {
  return process.env.NAS_REPORT_EMAIL?.trim() || process.env.REMINDER_ADMIN_EMAIL?.trim() || null
}

/**
 * Store a fresh NAS manifest, diff it, and fire notifications:
 *  - per-folder "✅ ซิงค์ครบ" email on the transition to complete (once per folder
 *    per content-signature, so a folder that grows and completes again re-notifies)
 *  - daily digest at most every 22h.
 * Returns the report (also what the admin button shows).
 */
export async function ingestNasManifest(manifest: NasManifest): Promise<NasSyncReport> {
  const report = await compareNasToDrive(manifest)

  const row = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } })
  const prev = (row?.status as any) || {}
  const next: any = { folders: { ...(prev.folders || {}) }, lastDailyAt: prev.lastDailyAt || null }

  const emailOk = isEmailConfigured() && !!reportEmailTo()
  for (const f of report.folders) {
    const code = codeOf(f.name) || f.name
    // Signature = file count + bytes: if the folder grows later, completing again re-notifies.
    const sig = `${f.nasFiles}|${f.nasBytes}`
    const prevF = next.folders[code] || {}
    if (f.complete && (!prevF.complete || prevF.sig !== sig)) {
      if (emailOk) {
        await sendEmail({
          to: [reportEmailTo()!],
          subject: `✅ ซิงค์ครบ: ${f.name} — ${f.nasFiles} ไฟล์ (${fmtGB(f.nasBytes)})`,
          text: `โฟลเดอร์ "${f.name}" ซิงค์จาก NAS ขึ้น Production Team ครบแล้ว\n${f.nasFiles} ไฟล์ · ${fmtGB(f.nasBytes)} · ตรงกัน 100%\n\nกด "รวมไฟล์เข้ากล่องนี้" ในหน้า upload ของงานได้เลย\nhttps://probook.xtec9.xyz/admin\n\n— THE STANDARD Production Booking`,
        }).catch(e => console.error('[nas-sync] complete email failed:', e?.message || e))
      }
      next.folders[code] = { complete: true, sig, emailedAt: new Date().toISOString() }
    } else {
      next.folders[code] = { ...prevF, complete: f.complete, sig: f.complete ? sig : prevF.sig }
    }
  }

  // Daily digest (agent pushes every ~10 min, so this check runs often enough).
  const lastDaily = next.lastDailyAt ? new Date(next.lastDailyAt).getTime() : 0
  if (emailOk && Date.now() - lastDaily > 22 * 3600_000) {
    await sendEmail({
      to: [reportEmailTo()!],
      subject: `📦 Daily NAS sync — ครบ ${report.completeCount}/${report.totalFolders} โฟลเดอร์`,
      text: digestText(report),
    }).catch(e => console.error('[nas-sync] daily email failed:', e?.message || e))
    next.lastDailyAt = new Date().toISOString()
  }

  await prisma.nasSyncState.upsert({
    where: { key: 'latest' },
    create: { key: 'latest', manifest: manifest as any, status: next },
    update: { manifest: manifest as any, status: next },
  })

  return report
}

/** Latest stored manifest (for the admin button when no fresh push arrived). */
export async function latestNasManifest(): Promise<NasManifest | null> {
  const row = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } })
  return (row?.manifest as unknown as NasManifest) || null
}
