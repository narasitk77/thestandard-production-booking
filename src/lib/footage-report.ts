/**
 * v1.89 — footage report for a booking: per camera, the files actually in the
 * Drive folder with size + duration + resolution (Drive auto-extracts video
 * metadata). Shown on the upload page and embedded in the "ส่งงาน" delivery
 * email. Lists the live Drive folder (not just app Upload rows) so anything
 * dropped there is reflected.
 */
import { prisma } from '@/lib/db'
import { listFolderFiles, getDriveParentFolderId, type DriveFolderFile } from '@/lib/google-drive'
import { buildEpisodeFolderName } from '@/lib/outlet-folders'

export interface CameraReport {
  camera: string
  folderId: string | null
  folderUrl: string | null
  files: DriveFolderFile[]
}
export interface FootageReport {
  bookingCode: string | null
  cameras: CameraReport[]
  totalFiles: number
  totalBytes: number
  deliveredAt: string | null
  deliveredBy: string | null
}

export async function buildFootageReport(bookingId: string): Promise<FootageReport> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { bookingCode: true, deliveredAt: true, deliveredBy: true, outlet: { select: { code: true } } },
  })
  const isAgency = booking?.outlet.code === 'AGN' // v1.94 — AGN EP labels use project EP ID
  const uploads = await prisma.upload.findMany({
    where: { bookingId, status: 'COMPLETE', driveFileId: { not: null } },
    orderBy: { completedAt: 'desc' },
    select: { camera: true, driveFileId: true, episodeId: true, episode: { select: { sequence: true, title: true, episodeId: true } } },
  })
  // v1.93 — one representative file per (episode, camera) → derive its folder →
  // list it. Multi-EP shoots report each EP's camera folder separately; the
  // label carries the EP ("EP01 · ตอน / CAM-A") so the report isn't ambiguous.
  const byGroup = new Map<string, { label: string; fileId: string }>()
  for (const u of uploads) {
    const key = `${u.episodeId ?? ''}|${u.camera}`
    if (!byGroup.has(key)) {
      byGroup.set(key, { label: u.episode ? `${buildEpisodeFolderName(u.episode, { useEpisodeId: isAgency })} / ${u.camera}` : u.camera, fileId: u.driveFileId! })
    }
  }

  const cameras: CameraReport[] = []
  let totalFiles = 0
  let totalBytes = 0
  for (const { label: camera, fileId } of Array.from(byGroup.values())) {
    let folderId: string | null = null
    try { folderId = await getDriveParentFolderId(fileId) } catch { /* file gone */ }
    let files: DriveFolderFile[] = []
    if (folderId) { try { files = await listFolderFiles(folderId) } catch { /* list hiccup */ } }
    totalFiles += files.length
    totalBytes += files.reduce((a, f) => a + (f.sizeBytes || 0), 0)
    cameras.push({
      camera,
      folderId,
      folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : null,
      files,
    })
  }
  cameras.sort((a, b) => a.camera.localeCompare(b.camera))
  return {
    bookingCode: booking?.bookingCode ?? null,
    cameras, totalFiles, totalBytes,
    deliveredAt: booking?.deliveredAt ? booking.deliveredAt.toISOString() : null,
    deliveredBy: booking?.deliveredBy ?? null,
  }
}

/** ms → "m:ss" (or "h:mm:ss"). */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** Plain-text rendering for the delivery email body. */
export function renderReportText(r: FootageReport): string {
  const lines: string[] = []
  for (const cam of r.cameras) {
    lines.push(`[${cam.camera}] ${cam.files.length} ไฟล์${cam.folderUrl ? ` — ${cam.folderUrl}` : ''}`)
    for (const f of cam.files) {
      const res = f.width ? `  ·  ${f.width}×${f.height}` : ''
      lines.push(`  • ${f.name}  ·  ${formatBytes(f.sizeBytes)}  ·  ${formatDuration(f.durationMillis)}${res}`)
    }
    if (cam.files.length === 0) lines.push('  (ยังไม่มีไฟล์)')
  }
  lines.push('')
  lines.push(`รวม: ${r.totalFiles} ไฟล์ · ${formatBytes(r.totalBytes)}`)
  return lines.join('\n')
}
