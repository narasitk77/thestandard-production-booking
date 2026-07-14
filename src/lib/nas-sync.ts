/**
 * v1.111 — NAS → Production Team (Drive) transfer verification.
 *
 * REALITY CHECK (observed 2026-07-03): the office NAS is a TRANSFER QUEUE, not a
 * mirror — the sync tool uploads a file to Drive and then DELETES it from the
 * NAS. So "ไฟล์มาครบแล้ว" ≠ "NAS == Drive"; it means "the NAS queue for this
 * folder has fully drained (everything shipped), and the files are on Drive".
 *
 * A tiny launchd agent on the admin's Mac (scripts/nas-manifest-agent.sh) scans
 * the SMB mount every ~10 min and POSTs a manifest. This lib:
 *   - tracks the per-folder queue (files still waiting on the NAS),
 *   - on the transition queue>0 → queue=0, counts the files on Drive by the
 *     folder's Production ID (global code search — survives ops hand-moves) and
 *     emails "✅ ส่งขึ้น Drive ครบ",
 *   - sends a daily digest at most every 22h,
 *   - powers the "ตรวจตอนนี้" button (live Drive counts per folder).
 */
import { prisma } from './db'
import { sendEmail, isEmailConfigured } from './email'
import { notifyDiscord } from './notify'
import { findFoldersByCode, listFilesRecursive, findChildFolder, SOUND_STAGING_DIR, listSoundStagingTree } from './google-drive'

const IGNORE_RE = /^_SHOOT\b.*\.txt$/i

export interface NasManifestFolder { name: string; files: Array<{ p: string; size: number }> }
export interface NasManifest { at: string; host?: string; folders: NasManifestFolder[] }

export interface FolderSyncReport {
  name: string
  code: string | null
  nasPending: number
  nasPendingBytes: number
  driveFiles: number | null   // null = not computed on this pass
  driveBytes: number | null
  state: 'sending' | 'sent' | 'empty'
}

export interface NasSyncReport {
  nasAt: string | null
  comparedAt: string
  folders: FolderSyncReport[]
  sendingCount: number
  sentCount: number
}

/** Production ID out of a folder name — "… (TSS-260702-01)" or a leading code. */
export function codeOf(name: string): string | null {
  const m = name.match(/\(([A-Z]{2,4}(?:-[A-Z0-9]+)*-\d{6}(?:-[A-Z0-9]+)*-?\d*)\)/) || name.match(/^([A-Z]{2,4}(?:-[A-Z0-9]+)*-\d{6}(?:-[A-Z0-9]+)*-?\d*)\b/)
  return m ? m[1] : null
}

/**
 * Count footage files on Drive for a Production ID: every code-bearing folder
 * anywhere (global search), excluding the sound-staging copy so audio the
 * sound-merge duplicated doesn't inflate the number.
 */
export async function countDriveFilesByCode(code: string): Promise<{ files: number; bytes: number }> {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  const stagingRoot = root ? await findChildFolder(root, SOUND_STAGING_DIR).catch(() => null) : null
  // v1.125 — staging booking folders may sit under up to two container layers
  // (outlet/category), so the exclusion set is the staging root PLUS every
  // container at any depth.
  const stagingContainers = new Set<string>()
  if (stagingRoot) {
    stagingContainers.add(stagingRoot)
    const tree = await listSoundStagingTree(stagingRoot).catch(() => ({ bookings: [], containerIds: [] }))
    for (const id of tree.containerIds) stagingContainers.add(id)
  }
  const candidates = await findFoldersByCode(code)
  let files = 0, bytes = 0
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    if ((c.parents || []).some(p => stagingContainers.has(p))) continue
    const raw = await listFilesRecursive(c.id, { maxFiles: 6000 })
    for (const f of raw) {
      if (IGNORE_RE.test(f.name)) continue
      files++
      bytes += f.size ?? 0
    }
  }
  return { files, bytes }
}

const GB = 1024 ** 3
const fmt = (b: number) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`

function reportEmailTo(): string | null {
  return process.env.NAS_REPORT_EMAIL?.trim() || process.env.REMINDER_ADMIN_EMAIL?.trim() || null
}

/**
 * Build the report. withDriveCounts pulls per-booking file counts from the
 * DETECT CACHE in the DB (Booking.footageCache — same source as the card badge):
 * live Drive counting for 15 folders blew past the 60s reverse proxy even in
 * parallel. The cache refreshes whenever anyone detects/uploads/merges; the
 * queue-drain email still does ONE live count for its folder.
 */
export async function buildNasReport(manifest: NasManifest, opts: { withDriveCounts?: boolean; statuses?: any } = {}): Promise<NasSyncReport> {
  const st = opts.statuses || {}
  const codes = manifest.folders.map(nf => codeOf(nf.name)).filter((v): v is string => !!v)
  const cacheByCode = new Map<string, { files: number | null; bytes: number | null }>()
  if (opts.withDriveCounts && codes.length) {
    const rows = await prisma.booking.findMany({
      where: { bookingCode: { in: codes } },
      select: { bookingCode: true, footageCache: true },
    })
    for (const r of rows) {
      const c = r.footageCache as any
      cacheByCode.set(r.bookingCode!, {
        files: typeof c?.fileCount === 'number' ? c.fileCount : null,
        bytes: Array.isArray(c?.folders) ? c.folders.reduce((n: number, f: any) => n + (f?.totalBytes || 0), 0) : null,
      })
    }
  }
  const folders: FolderSyncReport[] = manifest.folders.map(nf => {
    const code = codeOf(nf.name)
    const pendingBytes = nf.files.reduce((n, f) => n + (f.size || 0), 0)
    const prev = code ? st[code] : null
    const cached = code ? cacheByCode.get(code) : undefined
    const driveFiles = cached?.files ?? null
    const driveBytes = cached?.bytes ?? null
    const everHadFiles = (prev?.maxSeen || 0) > 0 || nf.files.length > 0
    const state: FolderSyncReport['state'] = nf.files.length > 0 ? 'sending'
      : everHadFiles || (driveFiles ?? 0) > 0 ? 'sent' : 'empty'
    return { name: nf.name, code, nasPending: nf.files.length, nasPendingBytes: pendingBytes, driveFiles, driveBytes, state }
  })
  return {
    nasAt: manifest.at ?? null,
    comparedAt: new Date().toISOString(),
    folders,
    sendingCount: folders.filter(f => f.state === 'sending').length,
    sentCount: folders.filter(f => f.state === 'sent').length,
  }
}

function digestText(report: NasSyncReport): string {
  const icon = (f: FolderSyncReport) => f.state === 'sending' ? '🔄' : f.state === 'sent' ? '✅' : '⏳'
  const lines = report.folders.map(f => {
    const drive = f.driveFiles != null ? ` · บน Drive ${f.driveFiles} ไฟล์${f.driveBytes ? ` (${fmt(f.driveBytes)})` : ''}` : ''
    const queue = f.nasPending > 0 ? ` · ค้างคิว NAS ${f.nasPending} ไฟล์ (${fmt(f.nasPendingBytes)})` : ''
    return `${icon(f)} ${f.name}${queue}${drive}`
  })
  return `รายงานส่งไฟล์ NAS → Production Team (Drive)
ข้อมูล NAS ณ ${report.nasAt ? new Date(report.nasAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'}
กำลังส่ง ${report.sendingCount} · ส่งครบแล้ว ${report.sentCount} (จาก ${report.folders.length} โฟลเดอร์)

${lines.join('\n')}

✅ = คิว NAS ว่าง ไฟล์อยู่บน Drive แล้ว · 🔄 = กำลังทยอยส่ง · ⏳ = ยังไม่มีไฟล์เข้า
— THE STANDARD Production Booking`
}

/**
 * Ingest a manifest push: track queue states, email on queue-drain (with the
 * live Drive count), daily digest every 22h. Returns the (light) report.
 */
export async function ingestNasManifest(manifest: NasManifest): Promise<NasSyncReport> {
  const row = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } })
  const prev = (row?.status as any) || {}
  const statuses: any = { ...(prev.folders || {}) }

  const emailOk = isEmailConfigured() && !!reportEmailTo()
  const report = await buildNasReport(manifest, { statuses })

  for (const f of report.folders) {
    if (!f.code) continue
    const p = statuses[f.code] || {}
    const maxSeen = Math.max(p.maxSeen || 0, f.nasPending)
    // Transition: queue had files, now drained → the sync shipped everything.
    if ((p.lastPending || 0) > 0 && f.nasPending === 0) {
      let driveNote = ''
      try {
        const c = await countDriveFilesByCode(f.code)
        driveNote = `\nบน Drive ตอนนี้: ${c.files} ไฟล์ (${fmt(c.bytes)})`
      } catch { /* best-effort */ }
      if (emailOk) {
        await sendEmail({
          to: [reportEmailTo()!],
          subject: `✅ ส่งขึ้น Drive ครบ: ${f.name}`,
          text: `คิว NAS ของ "${f.name}" ระบายหมดแล้ว — ไฟล์ทั้งหมดถูกส่งขึ้น Production Team (Drive) แล้ว${driveNote}\n\nกด "รวมไฟล์เข้ากล่องนี้" ในหน้า upload ของงานได้เลย\nhttps://probook.xtec9.xyz/admin\n\n— THE STANDARD Production Booking`,
        }).catch(e => console.error('[nas-sync] drain email failed:', e?.message || e))
      }
      // v1.147.2 (ops) — Discord ping on the same drain transition, alongside
      // the email. Independent of emailOk; notifyDiscord no-ops when the
      // webhook env is unset and never throws.
      await notifyDiscord(`✅ ซิงค์ขึ้น Drive ครบ: ${f.name} — คิว NAS ระบายหมดแล้ว${driveNote.replace('\n', ' · ')}`)
      statuses[f.code] = { ...p, lastPending: 0, maxSeen, drainedAt: new Date().toISOString() }
    } else {
      statuses[f.code] = { ...p, lastPending: f.nasPending, maxSeen }
    }
  }

  const next: any = { folders: statuses, lastDailyAt: prev.lastDailyAt || null }
  const lastDaily = next.lastDailyAt ? new Date(next.lastDailyAt).getTime() : 0
  if (emailOk && Date.now() - lastDaily > 22 * 3600_000) {
    // Daily digest gets live Drive counts (heavier — once a day is fine).
    const full = await buildNasReport(manifest, { withDriveCounts: true, statuses })
    await sendEmail({
      to: [reportEmailTo()!],
      subject: `📦 Daily NAS → Drive — ส่งครบ ${full.sentCount}/${full.folders.length} โฟลเดอร์`,
      text: digestText(full),
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

/** Latest stored manifest + statuses (for the admin button). */
export async function latestNasState(): Promise<{ manifest: NasManifest | null; statuses: any }> {
  const row = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } })
  return { manifest: (row?.manifest as unknown as NasManifest) || null, statuses: ((row?.status as any) || {}).folders || {} }
}

// ── v1.113.2 — EXACT per-file mirror verification ───────────────────────────
// "ตรวจว่าไฟล์เหมือนกัน 100%": for every folder in the NAS manifest, list the
// matching Production Team LANDING folder on Drive and diff by (basename, size).
// Answers "is every file currently on the NAS already on Drive?" — independent
// of the queue heuristic (which can't tell 'uploaded but not yet deleted' from
// 'not uploaded'). Files the merge already MOVED into the box also count as
// present: the fallback checks the booking's global code-matched folders.

export interface MirrorFolderResult {
  name: string
  nasFiles: number
  driveFiles: number
  matched: number
  missingOnDrive: number
  missingSample: string[]   // up to 8 relative paths
  state: 'match' | 'partial' | 'no-landing'
}

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

export async function verifyNasMirror(manifest: NasManifest): Promise<{ folders: MirrorFolderResult[]; allMatch: boolean }> {
  const { listChildFolders } = await import('./google-drive')
  const landingKids = await listChildFolders(PRODUCTION_TEAM_ROOT)
  const results: MirrorFolderResult[] = []

  for (const nf of manifest.folders) {
    const nasList = nf.files.filter(f => !IGNORE_RE.test(f.p.split('/').pop() || ''))
    if (nasList.length === 0) continue // empty NAS folder — nothing to verify
    const code = codeOf(nf.name)

    // landing folder: exact name first, then Production-ID match
    const landing = landingKids.find(k => k.name === nf.name)
      ?? (code ? landingKids.find(k => k.name.includes(`(${code})`) || k.name.startsWith(`${code} `)) : undefined)

    // Presence multiset = landing tree + every code-matched folder anywhere.
    const have = new Map<string, number>() // "name|size" -> count
    const addTree = async (rootId: string) => {
      const files = await listFilesRecursive(rootId, { maxFiles: 8000 })
      for (const f of files) {
        const k = `${f.name}|${f.size ?? ''}`
        have.set(k, (have.get(k) || 0) + 1)
      }
    }
    if (landing) await addTree(landing.id)
    if (code) {
      for (const c of await findFoldersByCode(code)) {
        if (landing && c.id === landing.id) continue
        await addTree(c.id)
      }
    }
    if (!landing && have.size === 0) {
      results.push({ name: nf.name, nasFiles: nasList.length, driveFiles: 0, matched: 0, missingOnDrive: nasList.length, missingSample: nasList.slice(0, 8).map(f => f.p), state: 'no-landing' })
      continue
    }

    let matched = 0
    const missing: string[] = []
    for (const f of nasList) {
      const base = f.p.split('/').pop() || f.p
      const k = `${base}|${f.size ?? ''}`
      const n = have.get(k) || 0
      if (n > 0) { have.set(k, n - 1); matched++ }
      else missing.push(f.p)
    }
    results.push({
      name: nf.name,
      nasFiles: nasList.length,
      driveFiles: Array.from(have.values()).reduce((a, b) => a + b, 0) + matched,
      matched,
      missingOnDrive: missing.length,
      missingSample: missing.slice(0, 8),
      state: missing.length === 0 ? 'match' : 'partial',
    })
  }

  return { folders: results, allMatch: results.every(r => r.state === 'match') }
}
