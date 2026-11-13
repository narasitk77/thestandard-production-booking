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
import { notifyChat } from './notify'
import { logAudit } from './audit'
import { findFoldersByCode, listFilesRecursive, findChildFolder, SOUND_STAGING_DIR, listSoundStagingTree } from './google-drive'
import { updateCardStates, quietShortCards, quietUnreadableCards, notOnDrive, shortCardText, CARD_RETRY_MS, type NasCardReport, type CardState } from './nas-cards'
import { alertOps } from './ops-alert'

const IGNORE_RE = /^_SHOOT\b.*\.txt$/i

export interface NasManifestFolder { name: string; files: Array<{ p: string; size: number }>; cards?: NasCardReport[]; truncated?: boolean; lastWrite?: number }
export interface NasManifest { at: string; host?: string; folders: NasManifestFolder[]; skipped?: string[] }

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
// v1.288 — one ingest at a time: the agent POSTs every minute now, and a slow ingest (drain counts, card checks on Drive)
// overlapped by the next POST read the same row twice → the same drain / card alert sent twice (review v1.288).
// ponytail: in-process chain — one app process serves this route; a DB advisory lock if that ever changes
let ingestChain: Promise<unknown> = Promise.resolve()
export function ingestNasManifest(manifest: NasManifest): Promise<NasSyncReport> {
  const run = ingestChain.then(() => ingestOnce(manifest))
  ingestChain = run.catch(() => {})
  return run
}

/** v1.288 — the queue must stay empty this long before "✅ ส่งขึ้น Drive ครบ": with a scan every minute, the short
 *  empty gap between two cards read as a drain (and mailed + chatted it) every time */
export const DRAIN_SETTLE_MS = 9 * 60_000

async function ingestOnce(manifest: NasManifest): Promise<NasSyncReport> {
  const row = await prisma.nasSyncState.findUnique({ where: { key: 'latest' } })
  const prev = (row?.status as any) || {}
  const statuses: any = { ...(prev.folders || {}) }

  const emailOk = isEmailConfigured() && !!reportEmailTo()
  const report = await buildNasReport(manifest, { statuses })

  // v1.262.1 — one state per Production ID, so sum every NAS folder carrying that ID first. Two folders
  // with the same ID (a re-dumped card, "X (1)") used to flip the state every manifest: one still
  // sending set lastPending>0, the empty one then "drained" it → a false ✅ every 10 minutes.
  const byCode = new Map<string, { name: string; nasPending: number }>()
  for (const f of report.folders) {
    if (!f.code) continue
    const cur = byCode.get(f.code)
    byCode.set(f.code, cur ? { name: `${cur.name} + ${f.name}`, nasPending: cur.nasPending + f.nasPending } : { name: f.name, nasPending: f.nasPending })
  }
  const announceDrain = async (code: string, name: string, p: any, maxSeen: number) => {
    let driveNote = ''
    let driveCount: { files: number; bytes: number } | null = null
    try {
      driveCount = await countDriveFilesByCode(code)
      driveNote = `\nบน Drive ตอนนี้: ${driveCount.files} ไฟล์ (${fmt(driveCount.bytes)})`
    } catch { /* best-effort */ }
    if (emailOk) {
      await sendEmail({
        to: [reportEmailTo()!],
        subject: `✅ ส่งขึ้น Drive ครบ: ${name}`,
        text: `คิว NAS ของ "${name}" ระบายหมดแล้ว — ไฟล์ทั้งหมดถูกส่งขึ้น Production Team (Drive) แล้ว${driveNote}\n\nกด "รวมไฟล์เข้ากล่องนี้" ในหน้า upload ของงานได้เลย\n${process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'}/admin\n\n— THE STANDARD Production Booking`,
      }).catch(e => console.error('[nas-sync] drain email failed:', e?.message || e))
    }
    // v1.147.2 (ops) — chat ping on the same drain transition, alongside the
    // email. Independent of emailOk; notifyChat no-ops when no chat webhook
    // is configured and never throws.
    await notifyChat(`✅ ซิงค์ขึ้น Drive ครบ: ${name} — คิว NAS ระบายหมดแล้ว${driveNote.replace('\n', ' · ')}`)
    // v1.262 — a durable record of the drain: the Hermes relay reads these to tell the operator's
    // Discord room (chat + email above are best-effort). v1.288 — zeroSince = when the queue really emptied (the row
    // itself is written DRAIN_SETTLE_MS later; footage-ready's fast-notice watch compares against this)
    await logAudit({
      actorEmail: 'nas-sync', action: 'nas.folder_drained', entityType: 'NasFolder', entityId: name, bookingCode: code,
      changes: { folder: name, ...(p.zeroSince ? { zeroSince: p.zeroSince } : {}), ...(driveCount ? { driveFiles: driveCount.files, driveBytes: driveCount.bytes } : {}) },
    })
    statuses[code] = { ...p, lastPending: 0, maxSeen, drainPending: false, drainedAt: new Date().toISOString() }
  }
  const settled = (p: any) => p.drainPending && Date.now() - Date.parse(p.zeroSince || '') >= DRAIN_SETTLE_MS
  for (const [code, f] of byCode) {
    const p = statuses[code] || {}
    const maxSeen = Math.max(p.maxSeen || 0, f.nasPending)
    // v1.288 — queue had files and is now empty: lastPending goes to 0 at once (footage-ready's gate reads it), but
    // the drain is ANNOUNCED only once it has stayed empty DRAIN_SETTLE_MS (a gap between two cards is not a drain)
    if ((p.lastPending || 0) > 0 && f.nasPending === 0) {
      statuses[code] = { ...p, lastPending: 0, maxSeen, drainPending: true, zeroSince: new Date().toISOString(), drainName: f.name }
      continue
    }
    // Transition confirmed: the queue stayed empty → the sync shipped everything.
    if (f.nasPending === 0 && settled(p)) await announceDrain(code, f.name, p, maxSeen)
    else statuses[code] = { ...p, lastPending: f.nasPending, maxSeen, ...(f.nasPending > 0 ? { drainPending: false } : {}) }
  }
  // v1.288 review — a folder that emptied and then LEFT the NAS (the noon prune trashes the merged landing, Cloud Sync
  // removes the NAS copy) while waiting out the settle: it shipped — say so. A folder the agent could not READ
  // (manifest.skipped) is not gone: it waits.
  const unreadable = new Set((manifest.skipped || []).map(n => codeOf(n)).filter(Boolean))
  for (const [code, p] of Object.entries(statuses) as Array<[string, any]>) {
    if (byCode.has(code) || unreadable.has(code) || !settled(p)) continue
    await announceDrain(code, p.drainName || code, p, p.maxSeen || 0)
  }

  // v1.288 — MEDIAPRO read on the NAS: remember what each card should hold and what arrived; a finished copy that is
  // short (and the missing originals are not on Drive either) is told to the team while the card is still in hand
  const cards = await checkNasCards(prev.cards || {}, manifest.folders, (row?.manifest as NasManifest | null | undefined)?.folders)
  const next: any = { folders: statuses, lastDailyAt: prev.lastDailyAt || null, cards }
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

/** v1.288 review — the card check walks Drive inside the (serialized) ingest: a hung call must not stall every later
 *  manifest. Past this, the manifest is stored with the card states as they were; the late check sends nothing. */
export const cardCheck = { deadlineMs: 90_000 } // an object so a test can shorten it

async function checkNasCards(prev: Record<string, CardState>, folders: NasManifestFolder[], before: NasManifestFolder[] | undefined): Promise<Record<string, CardState>> {
  const deadlineMs = cardCheck.deadlineMs
  const now = new Date()
  const base = updateCardStates(prev, folders, before, codeOf, now)
  const cards = { ...base }
  const run = { cancelled: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = await Promise.race([
    judgeCards(cards, now, run).then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), deadlineMs) }),
  ]).finally(() => clearTimeout(timer))
  if (!late) return cards
  run.cancelled = true
  console.error(`[nas-sync] card check ran past ${deadlineMs / 1000}s (Drive) — not judged this manifest`)
  return base
}

async function judgeCards(cards: Record<string, CardState>, now: Date, run: { cancelled: boolean }): Promise<void> {
  try {
    for (const { key, state } of quietUnreadableCards(cards, now)) {
      if (run.cancelled) return
      const r = await alertOps(`nas-card-unreadable:${key}`, `MEDIAPRO อ่านไม่ได้บน NAS — ${state.code || state.folder}`,
        `${state.folder} · ${state.dir || '(ราก)'}: MEDIAPRO.XML อ่านไม่ได้ (${state.error}) — ตรวจไม่ได้ว่าการ์ดนี้เข้า NAS ครบไหม\n` +
        'ด่าน MEDIAPRO บน Drive จะตรวจอีกรอบตอนไฟล์ขึ้นครบ · ถ้าไฟล์นี้เสียจริง ให้ก็อปการ์ดใหม่')
      if (r.delivered) cards[key] = { ...cards[key], alertedUnreadable: true }
    }
    const first = quietShortCards(cards, now, () => null)
    if (!first.length) return
    // the v1.260 rule needs each booking's first shoot day (clips dated before it = an unformatted card's leftovers)
    const codes = [...new Set(first.map(c => c.state.code).filter((c): c is string => !!c))]
    const rows = codes.length ? await prisma.booking.findMany({ where: { bookingCode: { in: codes } }, select: { bookingCode: true, shootDate: true } }) : []
    const from = new Map(rows.map(r => [r.bookingCode, new Date(r.shootDate).toISOString().slice(0, 10)]))
    const listings = new Map<string, Array<{ name: string; folderPath?: string[] }> | null>()
    const later = new Date(now.getTime() + CARD_RETRY_MS).toISOString()
    for (const { key, state, missing } of quietShortCards(cards, now, c => (c && from.get(c)) || null)) {
      // Not on the NAS ≠ missing: Cloud Sync uploads and removes a clip between two scans. The proof is THIS booking's
      // own Drive folders (landing / box / staging, found by its code), every name, one listing — a global name search
      // found another job's C0031.MP4 and skipped names past 20 (review v1.288). Cannot list = cannot judge = silent.
      if (!state.code) { cards[key] = { ...cards[key], retryAfter: later }; continue } // no Production ID: no folders to check
      let drive = listings.get(state.code)
      if (drive === undefined) {
        drive = null
        try {
          const roots = await findFoldersByCode(state.code)
          const all: Array<{ name: string; folderPath?: string[] }> = []
          let capped = false
          for (const r of roots) {
            const list = await listFilesRecursive(r.id, { maxFiles: 20000 })
            if (list.length >= 20000) capped = true
            all.push(...list)
          }
          if (roots.length && !capped) drive = all
          else console.warn('[nas-sync] card check: Drive folders of', state.code, roots.length ? 'too large to list' : 'not found', '— not judged')
        } catch (e: any) {
          console.warn('[nas-sync] card check: Drive listing failed — retry next manifest:', state.code, e?.message || e)
        }
        listings.set(state.code, drive)
      }
      if (!drive) { cards[key] = { ...cards[key], retryAfter: later }; continue }
      const gone = notOnDrive(missing, state.dir, drive)
      if (!gone) { cards[key] = { ...cards[key], retryAfter: later }; continue } // card path not proven on Drive yet
      const sig = missing.slice().sort().join('|')
      if (!gone.length) { cards[key] = { ...cards[key], alerted: sig }; continue } // all up already — not looked up again
      const text = shortCardText(state, gone)
      if (run.cancelled) return // abandoned by the deadline: the next manifest judges it again
      const told = await notifyChat(text)
      await alertOps(`nas-card-short:${key}:${sig}`, `การ์ดเข้า NAS ไม่ครบ — ${state.code}`, text)
      // remembered only once the TEAM heard it (ops alone cannot stop the card being formatted) — else retried next minute
      cards[key] = told ? { ...cards[key], alerted: sig } : { ...cards[key], retryAfter: later }
    }
  } catch (e: any) {
    console.error('[nas-sync] card check failed:', e?.message || e) // the manifest itself must still be stored
  }
}

/** Latest stored manifest + statuses (for the admin button). */
/**
 * v1.262 — how old the NAS picture is. The Mac agent pushes every 10 min; for 87 days (14 Jul → 9 Oct 2026)
 * it pushed nothing while the panel kept rendering the 14 Jul manifest as if it were live. Older than
 * NAS_MANIFEST_STALE_MINUTES (default 60) = stale: say so, never present it as current.
 */
export function nasManifestAge(at: string | null | undefined, now = new Date()): { ageMinutes: number | null; stale: boolean } {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return { ageMinutes: null, stale: true }
  const limit = Number(process.env.NAS_MANIFEST_STALE_MINUTES) > 0 ? Number(process.env.NAS_MANIFEST_STALE_MINUTES) : 60
  const ageMinutes = Math.max(0, Math.round((now.getTime() - t) / 60_000))
  return { ageMinutes, stale: ageMinutes > limit }
}

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
