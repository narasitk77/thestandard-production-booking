/**
 * Footage integrity scan (v1.221) — REPORT ONLY, never mutates.
 *
 * Why this exists. On 2026-09-11 two bookings (AGN-260911-01/02) finished the
 * whole pipeline "clean": landing empty, `video-merge` dry-run returning
 * `seen=0 moved=0 dup=0`, folder-integrity green. Nothing anywhere was
 * complaining. The footage was still wrong:
 *
 *   • `C004C002_260911WP.MXF` had landed at **0 bytes**
 *   • `A004R001_260911TJ.MXF` existed TWICE in one Clip folder, at 9.87 GB and
 *     47.9 GB — same name, wildly different size
 *   • one whole booking had AUDIO but every CAM-A/B/C empty — no video at all
 *
 * Every existing check answers "is the file where it should be?". None answers
 * "is the file any good?". `video-merge` counts what it moved; the landing
 * passes count what they trashed; folder-integrity checks the folder SHAPE.
 * A truncated upload satisfies all three. This module asks the missing question.
 *
 * It deliberately does NOT repair anything. Every remedy here is a delete or an
 * overwrite of real footage, and the TSS-WYS-260824-01 case proved the obvious
 * remedy can be exactly wrong: there, name+size matched between landing and box,
 * yet the BOX copy was the corrupt one. Deciding which copy is real needs the
 * source card, which this process cannot see. So: surface it, name it, and let
 * a human who can look at the card decide.
  *
 * v1.253 — the daily worker now runs the whole MEDIAPOOL-CHECK procedure (the
 * written runbook from the PP-26-034 incident) instead of three spot checks,
 * over EVERY booking shot in the window (paged — the old `take: 60` left most
 * of the month unchecked), and writes the result into each box as a Google Doc
 * named `_FOOTAGE-CHECK`, so whoever opens the folder sees what is missing:
 *
 *   • originals that never arrived (Sub/XML present, .MXF missing)
 *   • Sony sidecars missing next to an original (M01.XML — Sub only via the Media Pool)
 *   • the same original twice at different sizes (one upload did not finish)
 *   • files stranded in a TRASHED drop folder — the 723 GB PP-26-034 case
 *   • the editor's Media Pool (latest `<ProjectID>…drp` on Drive) vs the box, both ways
 *
 * Still report-only for footage: the one thing it writes is its own Doc.
 */
import { createHash } from 'crypto'
import { prisma } from './db'
import {
  listFilesRecursive, hasDriveCredentials, getDriveItemState, findTrashedFoldersByCode,
  listFolderTreeIncludingTrashed, findFootageCheckDocs, writeFootageCheckDoc, trashDriveItem,
  findLatestDrp, downloadDriveFile, classifyFootageTreeFolder, locateFileByName,
  type DriveFile, type TrashTreeFile,
} from './google-drive'
import {
  pendingOriginalClips, missingSidecars, sonyClipPart, isQuarantined, compareMediaPool, clipKey, baseName, hasUniqueClipName, type MediaPoolItem,
} from './footage-completeness'
import { parseDrpMediaPool } from './drp-mediapool'
import { loadMediaproCards, mediaproCheck, type MediaproCheck } from './mediapro'
import { folderNameMatchesCode } from './outlet-folders'
import { isShootMarkerFile, lastShootDay } from './reconciler/guards'

/** Google-native docs report no size at all; that is not a truncation. */
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps'

/**
 * v1.221.1 — camera sidecars that are LEGITIMATELY zero bytes.
 *
 * Caught by reading the NAS source on 2026-09-12: every Sony card carries
 * `SONY/SONYCARD.IND` at exactly 0 bytes, on the card itself, straight out of
 * the camera. 9 of them sit in the current NAS backlog. v1.221 shipped without
 * this list, so it would have reported a "0 ไบต์" fault on EVERY Sony shoot —
 * a guaranteed false positive, on a channel whose whole purpose is that someone
 * still reads it. An alert that cries wolf on normal footage is worse than no
 * alert: it trains the reader to skip the day the file really IS truncated.
 *
 * Match on the file NAME only. Deliberately not on the folder, because the
 * point is the file is empty BY DESIGN wherever it sits.
 */
const LEGIT_EMPTY_FILES = new Set(['sonycard.ind'])

/** Box walk ceiling — same as boxFootageState. Reaching it = "could not check", never "complete". */
const MAX_BOX_FILES = 20000
/** Originals can still be uploading this soon after the shoot (PP-26-034: 1–2 days) — shown in the Doc, kept out of chat. */
export const GRACE_DAYS = 3
const DOC_REFRESH_MS = 7 * 24 * 3_600_000
const DRP_MAX_BYTES = 64 * 1024 * 1024
const PURGE_MS = 30 * 24 * 3_600_000
const DOC_TEMPLATE = 'v1'

export type FootageIssueKind =
  | 'zero-byte' | 'duplicate-name' | 'audio-without-video'
  | 'missing-original' | 'missing-sidecar' | 'stranded-in-trash' | 'mediapool-missing' | 'mediapool-pending'
  | 'mediapro-missing' | 'mediapro-suspect' | 'mediapro-absent'

export interface FootageIssue {
  bookingCode: string
  kind: FootageIssueKind
  detail: string
  /** Drive ids involved — so a human can open exactly the right objects. */
  fileIds: string[]
  /** v1.254 — EP/camera folder an issue belongs to when there is no file to point at (a file that is NOT there) */
  group?: { ep: string; cam: string }
  /** v1.258 — where a file of that name was seen elsewhere. Shown to people, kept OUT of issueKey: it can change run to run */
  hint?: string
}

export const ISSUE_LABEL: Record<FootageIssueKind, string> = {
  'zero-byte': '0 ไบต์',
  'duplicate-name': 'ชื่อซ้ำ',
  'audio-without-video': 'มีเสียงแต่ไม่มีวิดีโอ',
  'missing-original': 'ขาดต้นฉบับ',
  'missing-sidecar': 'ขาดไฟล์ประกอบ',
  'stranded-in-trash': 'ค้างในถังขยะ',
  'mediapool-missing': 'อยู่ใน Media Pool แต่ไม่มีในกล่อง',
  'mediapool-pending': 'อยู่ใน Media Pool แต่ในกล่องยังไม่ครบ',
  'mediapro-missing': 'ขาดตาม MEDIAPRO',
  'mediapro-suspect': 'น่าจะก็อปไม่จบ',
  'mediapro-absent': 'การ์ดไม่มี MEDIAPRO',
}

/** Kinds that are normal while an upload is still running — only these wait out GRACE_DAYS. */
const WAITING_KINDS = new Set<FootageIssueKind>(['missing-original', 'missing-sidecar', 'mediapool-pending', 'mediapro-missing', 'mediapro-absent'])
const isLive = (i: FootageIssue, waiting: boolean) => !(waiting && WAITING_KINDS.has(i.kind))

/** `size` is `number | null`; only a real 0 counts. `null` = Google-native. */
function isZeroByte(f: DriveFile): boolean {
  if (f.size !== 0) return false
  if (f.mimeType?.startsWith(GOOGLE_NATIVE_PREFIX)) return false
  if (LEGIT_EMPTY_FILES.has(f.name.trim().toLowerCase())) return false
  return true
}

function isRealFootage(f: DriveFile): boolean {
  if (isShootMarkerFile(f.name)) return false
  if (f.mimeType?.startsWith(GOOGLE_NATIVE_PREFIX)) return false
  return true
}

/**
 * A camera-card group. Sony/Canon trees nest deeply
 * (CAM-A/XDROOT/Clip/…, CAM-A/M4ROOT/CLIP/…), so the group is
 * `folderPath[1]` — folderPath[0] is the EPISODE folder under the box root.
 */
function cameraGroup(f: DriveFile): string | null {
  const g = f.folderPath?.[1]
  return g ? g.toUpperCase() : null
}

const gb = (n: number | null | undefined) => (n == null ? '?' : `${(n / 1e9).toFixed(2)} GB`)
const where = (f: { folderPath?: string[]; name: string }) => [...(f.folderPath || []), f.name].join('/')

export function findIssues(bookingCode: string, files: DriveFile[]): FootageIssue[] {
  const issues: FootageIssue[] = []
  // v1.253 — files a person set aside in `_แยกไว้ · …` (e.g. the truncated A004R001) are out of every check.
  const real = files.filter(f => isRealFootage(f) && !isQuarantined(f))

  // ── 1. truncated uploads ───────────────────────────────────────────────────
  for (const f of real) {
    if (!isZeroByte(f)) continue
    issues.push({ bookingCode, kind: 'zero-byte', fileIds: [f.id], detail: `${where(f)} — 0 ไบต์` })
  }

  // ── 2. same name twice in ONE folder ───────────────────────────────────────
  // Drive allows it; a camera never does. It means two upload attempts landed
  // side by side, and at most one of them is the whole clip. Size is reported
  // so a human can see the mismatch, NOT so the smaller one can be assumed bad.
  const byFolderAndName = new Map<string, DriveFile[]>()
  for (const f of real) {
    const parent = f.parents?.[0] || '?'
    const key = `${parent}\u0000${f.name}`
    const list = byFolderAndName.get(key)
    if (list) list.push(f)
    else byFolderAndName.set(key, [f])
  }
  for (const dupes of byFolderAndName.values()) {
    if (dupes.length < 2) continue
    const sizes = dupes.map(d => gb(d.size)).join(' vs ')
    issues.push({
      bookingCode, kind: 'duplicate-name', fileIds: dupes.map(d => d.id),
      detail: `${where(dupes[0])} — มี ${dupes.length} ไฟล์ชื่อเดียวกันในโฟลเดอร์เดียวกัน (${sizes})`,
    })
  }

  // ── 2b. v1.253 — one FX6 original in two folders at different sizes ─────────
  // FX6 names carry reel+date+camera, so the same name twice is the same clip —
  // A004R001_260911TJ sat in two Clip folders at 9.87 and 47.91 GB. Equal sizes
  // are a card copied twice ("Card 2" + "Card 2 (คอมดับ)") and are fine.
  const origByName = new Map<string, DriveFile[]>()
  for (const f of real) {
    const p = sonyClipPart(f.name)
    if (p?.part !== 'orig' || !/^[A-Z]\d{3}[A-Z]\d{3}_/i.test(p.clip)) continue
    const k = f.name.toUpperCase()
    origByName.set(k, [...(origByName.get(k) || []), f])
  }
  for (const copies of origByName.values()) {
    const parents = new Set(copies.map(c => c.parents?.[0]))
    const sizes = new Set(copies.map(c => c.size))
    if (parents.size < 2 || sizes.size < 2) continue
    issues.push({
      bookingCode, kind: 'duplicate-name', fileIds: copies.map(c => c.id),
      detail: `${copies[0].name} — ต้นฉบับชื่อเดียวกัน ${copies.length} ไฟล์ ขนาดต่างกัน (${copies.map(c => gb(c.size)).join(' vs ')}) — ตัวเล็กอาจอัปไม่จบ`,
    })
  }

  // ── 3. an episode with sound but no picture ────────────────────────────────
  // The shape that hid AGN-260911-02: AUDIO arrived, every CAM-* stayed empty,
  // and because an empty folder holds no files nothing downstream noticed.
  const byEpisode = new Map<string, { audio: number; video: number }>()
  for (const f of real) {
    const ep = f.folderPath?.[0]
    if (!ep) continue
    const group = cameraGroup(f)
    const row = byEpisode.get(ep) || { audio: 0, video: 0 }
    if (group === 'AUDIO') row.audio++
    else if (group?.startsWith('CAM')) row.video++
    byEpisode.set(ep, row)
  }
  for (const [ep, row] of byEpisode) {
    if (row.audio > 0 && row.video === 0) {
      issues.push({
        bookingCode, kind: 'audio-without-video', fileIds: [],
        detail: `${ep} — มีเสียง ${row.audio} ไฟล์ แต่ไม่มีวิดีโอใน CAM-* เลย`,
      })
    }
  }

  // ── 4. v1.253 — originals that never arrived (same rule as the v1.251 prune guard) ──
  // File ids are matched by the clip KEY, so a repeatable M4ROOT name (C0001) points
  // at the card that is short, not at every C0001 in the box.
  const partsOf = (clip: string, key: string) => {
    const re = new RegExp(`^${clip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(S03\\.MP4|M01\\.XML|\\.[A-Z0-9]+)$`, 'i')
    return real.filter(f => re.test(baseName(f.name)) && clipKey(f, clip) === key).map(f => f.id)
  }
  const at = (group: string) => (group ? `${group} · ` : '')
  const pending = pendingOriginalClips(real)
  for (const p of pending) {
    issues.push({
      bookingCode, kind: 'missing-original', fileIds: partsOf(p.clip, p.key),
      detail: `${at(p.group)}${p.clip} — มี Sub/M01.XML แล้ว แต่ยังไม่มีต้นฉบับ (.MXF/.MP4)`,
    })
  }
  // 4b. The prune gate only counts a Sub inside `Sub/` and an XML inside `Clip/`. Here a
  // Sony Sub/XML dragged in WITHOUT its card folders (flat, or a "Proxy" folder) must
  // not let the box read "complete" — sonyClipPart's camera-name rule already keeps
  // exports like Teaser_EPS03.mp4 out.
  const flagged = new Set(pending.map(p => p.key))
  const haveOrig = new Set<string>()
  const loose = new Map<string, { clip: string; group: string }>()
  for (const f of real) {
    const p = sonyClipPart(f.name)
    if (!p) continue
    const key = clipKey(f, p.clip)
    if (p.part === 'orig') haveOrig.add(key)
    else if (!loose.has(key)) loose.set(key, { clip: p.clip, group: (f.folderPath || []).slice(0, 2).join('/') })
  }
  for (const [key, l] of loose) {
    if (haveOrig.has(key) || flagged.has(key)) continue
    issues.push({
      bookingCode, kind: 'missing-original', fileIds: partsOf(l.clip, key),
      detail: `${at(l.group)}${l.clip} — มี Sub/M01.XML (นอกโครงการ์ด) แต่ไม่มีต้นฉบับ`,
    })
  }

  // ── 5. v1.253 — an original whose M01.XML did not come with it ─────────────
  for (const m of missingSidecars(real)) {
    issues.push({
      bookingCode, kind: 'missing-sidecar',
      fileIds: real.filter(f => { const p = sonyClipPart(f.name); return p?.part === 'orig' && clipKey(f, p.clip) === m.key }).map(f => f.id),
      detail: `${at(m.group)}${m.clip} — มีต้นฉบับ แต่ขาด ${m.missing.join(' · ')}`,
    })
  }

  return issues
}

/** v1.254 — the same MEDIAPRO rule the "footage ready" email waits for, as issues for the Doc. (0-byte files are already a zero-byte issue.) */
export function mediaproIssues(bookingCode: string, c: MediaproCheck, foundAt: Map<string, string> = new Map()): FootageIssue[] {
  const card = (p: string) => p.split('/').slice(-3).join('/')
  const hint = (file: string) => { const w = foundAt.get(file.split('/').pop() || ''); return w ? { hint: w } : {} }
  const group = (p: string[]) => ({ ep: p[0] || '(ไฟล์ที่ root ของกล่อง)', cam: p[1] || '' })
  return [
    ...c.missing.map(m => ({ bookingCode, kind: 'mediapro-missing' as const, fileIds: [], group: group(m.cardPath), ...hint(m.file),
      detail: `${card(m.card)} · ${m.file} — อยู่ใน MEDIAPRO.XML ของการ์ด แต่ไม่มีในกล่อง` })),
    ...c.suspect.map(m => ({ bookingCode, kind: 'mediapro-suspect' as const, fileIds: m.id ? [m.id] : [],
      detail: `${card(m.card)} · ${m.file} — ขนาดต่อเฟรม ${m.ratio}× ของคลิปแบบเดียวกัน (น่าจะก็อปไม่จบ)` })),
    ...c.unverifiablePaths.map(p => ({ bookingCode, kind: 'mediapro-absent' as const, fileIds: [], group: group(p),
      detail: `${card(p.join('/'))} — มีต้นฉบับกล้อง Sony แต่ไม่มี MEDIAPRO.XML ระบุไว้ ตรวจไม่ได้ว่าก็อปครบไหม (ก็อปทั้งการ์ด ไม่ใช่แค่โฟลเดอร์ Clip)` })),
  ]
}

// ── trashed drop folders ─────────────────────────────────────────────────────

const OS_JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|SALVAGE\.TMP)$/i

export interface StrandedSummary { files: number; bytes: number; purgeAfter: string | null }

/**
 * Files under a trashed drop folder that the box does not have. Present = same
 * md5 anywhere in the box; name+size only when one side has no md5 (TSS-WYS-260824-01:
 * name+size matched and the contents did not — md5 wins whenever both have one).
 */
export function strandedFiles(trashFiles: TrashTreeFile[], boxFiles: DriveFile[]): TrashTreeFile[] {
  const boxMd5 = new Set(boxFiles.map(f => f.md5).filter(Boolean) as string[])
  const byNameSize = new Map<string, DriveFile[]>()
  for (const f of boxFiles) {
    const k = `${f.name.toUpperCase()}|${f.size}`
    byNameSize.set(k, [...(byNameSize.get(k) || []), f])
  }
  return trashFiles.filter(f => {
    if (!f.size || OS_JUNK.test(f.name) || f.name.startsWith('._') || isShootMarkerFile(f.name)) return false
    if (f.md5 && boxMd5.has(f.md5)) return false
    return !(byNameSize.get(`${f.name.toUpperCase()}|${f.size}`) || []).some(b => !b.md5 || !f.md5)
  })
}

async function probeTrashedLanding(code: string, landingId: string | undefined, boxFiles: DriveFile[]):
  Promise<{ issues: FootageIssue[]; stranded: StrandedSummary | null; error: string | null }> {
  const folders = new Map<string, string | null>()
  try {
    if (landingId) {
      const st = await getDriveItemState(landingId)
      if (st?.trashed) folders.set(st.id, st.trashedTime)
    }
    for (const f of await findTrashedFoldersByCode(code)) folders.set(f.id, f.trashedTime)
  } catch (e: any) {
    return { issues: [], stranded: null, error: `ตรวจโฟลเดอร์ drop ในถังขยะไม่ได้: ${e?.message || e}` }
  }
  const issues: FootageIssue[] = []
  const errs: string[] = []
  let bytes = 0
  let purge: number | null = null
  for (const [id, trashedTime] of folders) {
    // One unreadable folder must not hide what another one already showed (30-day purge clock).
    let tree
    try { tree = await listFolderTreeIncludingTrashed(id, 5000) }
    catch (e: any) { errs.push(`อ่านโฟลเดอร์ drop ในถังขยะไม่ได้: ${e?.message || e}`); continue }
    if (tree.truncated) errs.push('โฟลเดอร์ drop ในถังขยะมีไฟล์เกิน 5000 — ตรวจไม่ครบ')
    const lost = strandedFiles(tree.files, boxFiles)
    if (!lost.length) continue
    const purgeAt = trashedTime ? Date.parse(trashedTime) + PURGE_MS : null
    if (purgeAt && (purge == null || purgeAt < purge)) purge = purgeAt
    for (const f of lost) {
      bytes += f.size || 0
      issues.push({
        bookingCode: code, kind: 'stranded-in-trash', fileIds: [f.id],
        detail: `${where(f)} — ${gb(f.size)} · ไม่มีในกล่องนี้${purgeAt ? ` · ลบถาวรราว ${thaiDate(new Date(purgeAt))}` : ''}`,
      })
    }
  }
  return {
    issues,
    stranded: issues.length ? { files: issues.length, bytes, purgeAfter: purge ? new Date(purge).toISOString() : null } : null,
    error: errs.length ? errs.join(' · ') : null,
  }
}

// ── Media Pool (.drp) ────────────────────────────────────────────────────────

export interface MediaPoolLine {
  drp: { name: string; modifiedTime: string | null; url: string | null } | null
  status: 'no-drp' | 'error' | 'drp-before-shoot' | 'not-loaded' | 'synced' | 'partial'
  inPool: number
  missing: number
  notInPool: string[]
  error?: string
}

type DrpLoad =
  | { ok: true; drp: { name: string; modifiedTime: string | null; url: string | null }; pool: MediaPoolItem[] }
  | { ok: false; drp: { name: string; modifiedTime: string | null; url: string | null } | null; error: string | null }

// Parsed projects by `<id>:<modifiedTime>` — one project spans pages; download once per process.
const drpParsed = new Map<string, MediaPoolItem[]>()

async function loadDrp(projectId: string): Promise<DrpLoad> {
  let drp = null
  try {
    const f = await findLatestDrp(projectId)
    if (!f) return { ok: false, drp: null, error: null }
    drp = { name: f.name, modifiedTime: f.modifiedTime, url: f.webViewLink }
    if (f.size != null && f.size > DRP_MAX_BYTES) return { ok: false, drp, error: `${f.name} ใหญ่เกิน ${DRP_MAX_BYTES / 1048576} MB` }
    const key = `${f.id}:${f.modifiedTime}`
    let pool = drpParsed.get(key)
    if (!pool) {
      pool = parseDrpMediaPool(await downloadDriveFile(f.id))
      if (drpParsed.size >= 20) drpParsed.delete(drpParsed.keys().next().value!)
      drpParsed.set(key, pool)
    }
    // A project with bins but no clips reads exactly like a parser that broke on a new
    // Resolve version. Say so instead of reporting every file as "not in the Media Pool".
    if (!pool.length) return { ok: false, drp, error: `${f.name} มี bin แต่ไม่มีคลิปเลย (ยังไม่ได้ import หรือรูปแบบไฟล์เปลี่ยน)` }
    return { ok: true, drp, pool }
  } catch (e: any) {
    return { ok: false, drp, error: `อ่าน Media Pool ไม่ได้: ${e?.message || e}` }
  }
}

function mediaPoolLine(load: DrpLoad, code: string, shootDate: string, files: DriveFile[]): { line: MediaPoolLine; issues: FootageIssue[] } {
  const empty = { inPool: 0, missing: 0, notInPool: [] as string[] }
  if (!load.ok) {
    return { line: { drp: load.drp, status: load.error ? 'error' : 'no-drp', ...empty, ...(load.error ? { error: load.error } : {}) }, issues: [] }
  }
  if (load.drp.modifiedTime && load.drp.modifiedTime.slice(0, 10) < shootDate) {
    return { line: { drp: load.drp, status: 'drp-before-shoot', ...empty }, issues: [] }
  }
  const cmp = compareMediaPool(load.pool, code, files)
  const status = cmp.inPool === 0 ? 'not-loaded' : (cmp.missing.length || cmp.notInPool.length) ? 'partial' : 'synced'
  return {
    line: { drp: load.drp, status, inPool: cmp.inPool, missing: cmp.missing.length, notInPool: cmp.notInPool },
    // Missing original/XML/Sub can still be uploading (Sub-first, like PP-26-034) → waits out
    // GRACE_DAYS like missing-original. A missing WAV has no such excuse.
    issues: cmp.missing.map(m => ({
      bookingCode: code, fileIds: [],
      kind: m.lacks.includes('WAV') ? 'mediapool-missing' as const : 'mediapool-pending' as const,
      detail: `${m.name} — อยู่ใน Media Pool แต่ในกล่องไม่มี ${m.lacks.join(' · ')}`,
    })),
  }
}

// ── one box ──────────────────────────────────────────────────────────────────

export type BoxState = 'ok' | 'issues' | 'waiting' | 'no-sony' | 'empty' | 'unreadable'
export type DocAction =
  | 'created' | 'updated' | 'refreshed' | 'unchanged'
  | 'would-create' | 'would-update' | 'would-refresh' | 'skipped' | 'failed'

export interface BoxCheck {
  bookingCode: string
  projectId: string | null
  shootDate: string
  boxId: string
  state: BoxState
  /** shot less than GRACE_DAYS ago — missing originals may still be uploading */
  waiting: boolean
  files: number
  bytes: number
  counts: Partial<Record<FootageIssueKind, number>>
  /** first 20 (the Doc has all of them) */
  issues: FootageIssue[]
  stranded: StrandedSummary | null
  mediaPool: MediaPoolLine | null
  /** fingerprint of the live issues (kind + detail) — what "news" is measured against */
  issueKey: string
  /** `announced` = the issueKey last delivered to chat (kept on the Doc; set by the summary POST) */
  doc: { action: DocAction; url: string | null; note?: string; id?: string | null; announced?: string | null }
  /** checks that could not run — never read as "passed" */
  errors: string[]
}

export function issueKey(issues: FootageIssue[], waiting: boolean): string {
  const live = issues.filter(i => isLive(i, waiting)).map(i => `${i.kind}\u0000${i.detail}`).sort()
  return createHash('sha1').update(live.join('\n')).digest('hex')
}

export interface GroupRow { ep: string; cam: string; files: number; bytes: number; audio: boolean; sony: boolean; kinds: FootageIssueKind[] }

export function groupRows(files: DriveFile[], issues: FootageIssue[]): GroupRow[] {
  const rows = new Map<string, GroupRow>()
  const rowOf = new Map<string, GroupRow>()
  for (const f of files) {
    if (!isRealFootage(f) || isQuarantined(f)) continue
    const ep = f.folderPath?.[0] || '(ไฟล์ที่ root ของกล่อง)'
    const cam = f.folderPath?.[1] || ''
    const k = `${ep}\u0000${cam}`
    const r = rows.get(k) || { ep, cam, files: 0, bytes: 0, audio: cam.toUpperCase() === 'AUDIO', sony: false, kinds: [] }
    r.files++
    r.bytes += f.size || 0
    if (sonyClipPart(f.name)) r.sony = true
    rows.set(k, r)
    rowOf.set(f.id, r)
  }
  for (const i of issues) {
    const hit = [...i.fileIds.map(id => rowOf.get(id)), i.group ? rows.get(`${i.group.ep}\u0000${i.group.cam}`) : undefined]
    for (const r of hit) if (r && !r.kinds.includes(i.kind)) r.kinds.push(i.kind)
  }
  return [...rows.values()].sort((a, b) => (a.ep + a.cam).localeCompare(b.ep + b.cam))
}

export function boxState(o: { readable: boolean; files: DriveFile[]; issues: FootageIssue[]; waiting: boolean }): BoxState {
  if (!o.readable) return 'unreadable'
  const live = o.issues.filter(i => isLive(i, o.waiting))
  if (live.length) return 'issues'
  if (o.issues.length) return 'waiting'
  const real = o.files.filter(f => isRealFootage(f) && !isQuarantined(f))
  if (!real.length) return 'empty'
  return real.some(f => sonyClipPart(f.name)) ? 'ok' : 'no-sony'
}

// ── the per-box Doc ──────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const link = (id: string) => `https://drive.google.com/open?id=${encodeURIComponent(id)}`

export function thaiDate(d: Date, withTime = false): string {
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d)
}

export interface CheckDocInput {
  bookingCode: string
  projectId: string | null
  projectName: string | null
  shootDate: string
  state: BoxState
  waiting: boolean
  files: number
  bytes: number
  issues: FootageIssue[]
  rows: GroupRow[]
  stranded: StrandedSummary | null
  mediaPool: MediaPoolLine | null
  errors: string[]
}

/**
 * The Doc body. Everything that decides the content goes into the hash; the
 * "checked at" line does not, so an unchanged box is not rewritten every day.
 */
export function renderCheckDoc(input: CheckDocInput, meta: { checkedAt: Date; appUrl: string }): { html: string; hash: string } {
  // Drive lists a folder tree in no fixed order (and the walk is concurrent), so sort
  // everything that reaches the body — otherwise the hash flips and an unchanged box
  // is rewritten every run.
  const c = {
    ...input,
    issues: [...input.issues]
      .map(i => ({ ...i, fileIds: [...i.fileIds].sort() }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail)),
    rows: input.rows.map(r => ({ ...r, kinds: [...r.kinds].sort() })),
  }
  const live = c.issues.filter(i => isLive(i, c.waiting))
  const statusLine: Record<BoxState, string> = {
    ok: '✅ ครบ — ทุกคลิปกล้องในกล่องมีต้นฉบับ + M01.XML',
    issues: `⚠️ ต้องตามต่อ ${live.length} จุด`,
    waiting: `⏳ รอต้นฉบับ ${c.issues.length} จุด — ถ่ายไม่ถึง ${GRACE_DAYS} วัน ไฟล์อาจยังอัปไม่เสร็จ`,
    'no-sony': `ℹ️ มี ${c.files} ไฟล์ — ตรวจความครบไม่ได้ (ไม่ใช่โครงการ์ด Sony) ระบบนับไฟล์ให้อย่างเดียว`,
    empty: '⬜ ยังไม่มีฟุตเทจในกล่อง',
    unreadable: '❔ ตรวจไม่ได้รอบนี้ — ห้ามถือว่าครบ',
  }
  const rowStatus = (r: GroupRow) => {
    if (r.kinds.length) return c.waiting && r.kinds.every(k => WAITING_KINDS.has(k)) ? '⏳ รอต้นฉบับ' : `⚠️ ${r.kinds.map(k => ISSUE_LABEL[k]).join(' · ')}`
    if (r.audio) return 'เสียง'
    return r.sony ? '✅ ครบ' : 'นับไฟล์อย่างเดียว'
  }
  const issueLine = (i: FootageIssue) =>
    `<li>[${esc(ISSUE_LABEL[i.kind])}] ${esc(i.detail)}${i.fileIds[0] ? ` · <a href="${link(i.fileIds[0])}">เปิด</a>` : ''}${i.hint ? ` · 🔎 พบไฟล์ชื่อนี้อยู่ที่ ${esc(i.hint)}` : ''}</li>`

  const out: string[] = []
  out.push(`<h1>ตรวจฟุตเทจ · ${esc(c.bookingCode)}</h1>`)
  out.push(`<p>${esc([c.projectId, c.projectName].filter(Boolean).join(' · '))}${c.projectId || c.projectName ? ' · ' : ''}ถ่าย ${esc(thaiDate(new Date(c.shootDate)))} · ${c.files} ไฟล์ ${esc(gb(c.bytes))}</p>`)
  out.push(`<h2>${esc(statusLine[c.state])}</h2>`)
  for (const e of c.errors) out.push(`<p>⚠️ ตรวจบางส่วนไม่ได้: ${esc(e)}</p>`)

  const stranded = c.issues.filter(i => i.kind === 'stranded-in-trash')
  if (stranded.length && c.stranded) {
    out.push(`<h2>🚨 มีไฟล์ค้างในโฟลเดอร์ drop ที่ถูกทิ้งลงถังขยะ ${stranded.length} ไฟล์ ${esc(gb(c.stranded.bytes))}${c.stranded.purgeAfter ? ` — จะถูกลบถาวรราว ${esc(thaiDate(new Date(c.stranded.purgeAfter)))}` : ''}</h2>`)
    out.push(`<ul>${stranded.slice(0, 40).map(issueLine).join('')}${stranded.length > 40 ? `<li>…อีก ${stranded.length - 40} ไฟล์</li>` : ''}</ul>`)
    out.push('<p>แจ้งแอดมินให้ย้ายเข้ากล่องนี้ — อย่ากู้ทั้งโฟลเดอร์กลับที่เดิม</p>')
  }

  if (c.rows.length) {
    out.push('<h3>ราย EP / กล้อง</h3><table><tr><th>EP</th><th>กล้อง</th><th>ไฟล์</th><th>ขนาด</th><th>สถานะ</th></tr>')
    for (const r of c.rows) {
      out.push(`<tr><td>${esc(r.ep)}</td><td>${esc(r.cam)}</td><td>${r.files}</td><td>${esc(gb(r.bytes))}</td><td>${esc(rowStatus(r))}</td></tr>`)
    }
    out.push('</table>')
  }

  const rest = c.issues.filter(i => i.kind !== 'stranded-in-trash')
  if (rest.length) {
    out.push(`<h3>ต้องตามต่อ (${rest.length})</h3><ul>${rest.slice(0, 60).map(issueLine).join('')}${rest.length > 60 ? `<li>…อีก ${rest.length - 60} จุด</li>` : ''}</ul>`)
  }

  out.push('<h3>Media Pool</h3>')
  const mp = c.mediaPool
  if (!c.projectId) out.push('<p>ใบจองนี้ไม่มี Production ID — ไม่ได้เทียบ</p>')
  else if (!mp) out.push('<p>ไม่ได้เทียบรอบนี้ (อ่านกล่องไม่ได้)</p>')
  else {
    const src = mp.drp ? `${esc(mp.drp.name)}${mp.drp.modifiedTime ? ` · บันทึก ${esc(thaiDate(new Date(mp.drp.modifiedTime), true))}` : ''}` : ''
    const text: Record<MediaPoolLine['status'], string> = {
      'no-drp': `ไม่พบไฟล์โปรเจกต์ DaVinci (${esc(c.projectId)}_DaVinci_&lt;วันที่&gt;.drp) บน Drive — ไม่ได้เทียบ (ไม่ได้แปลว่าซิงก์ครบ)`,
      error: `${src} — ${esc(mp.error || 'อ่านไม่ได้')}`,
      'drp-before-shoot': `${src} — บันทึกก่อนวันถ่าย ยังไม่มีคิวนี้`,
      'not-loaded': `${src} — คิวนี้ยังไม่อยู่ใน Media Pool (ในกล่องมีคลิป/WAV ${mp.notInPool.length} รายการ)`,
      synced: `${src} — ✅ ซิงก์ครบ ${mp.inPool} รายการ`,
      partial: `${src} — ใน Media Pool ${mp.inPool} รายการ · ไม่มีในกล่อง ${mp.missing} · อยู่ในกล่องแต่ยังไม่อยู่ใน Media Pool ${mp.notInPool.length}`,
    }
    out.push(`<p>${text[mp.status]}</p>`)
    if (mp.notInPool.length && mp.status !== 'not-loaded') {
      out.push(`<p>ยังไม่อยู่ใน Media Pool: ${esc(mp.notInPool.slice(0, 15).join(', '))}${mp.notInPool.length > 15 ? ` …อีก ${mp.notInPool.length - 15}` : ''}</p>`)
    }
  }

  out.push('<h3>ตรวจอะไร / อ่านยังไง</h3><ol>')
  out.push('<li>คลิปกล้อง Sony 1 คลิป = ต้นฉบับ (.MXF/.MP4) + …M01.XML ต้องอยู่ในกล่องนี้ครบ · Sub (…S03.MP4) ต้องมีเมื่อคนตัดใช้ตัวนั้นใน Media Pool · กล้องอื่นนับไฟล์ให้อย่างเดียว</li>')
  out.push('<li>ไฟล์ 0 ไบต์ / ต้นฉบับชื่อเดียวกันขนาดต่างกัน = อัปไม่จบ — อย่าลบหรือย้ายจนกว่าจะเทียบกับการ์ดต้นทาง</li>')
  out.push('<li>ทุกไฟล์ที่ MEDIAPRO.XML ของการ์ด Sony ระบุ (ต้นฉบับ · Sub · M01.XML · ภาพย่อ) ต้องอยู่ในกล่อง · การ์ดที่ไม่มี MEDIAPRO = ตรวจไม่ได้ — ระบบไม่แจ้ง "ไฟล์พร้อม" จนกว่าจะครบ</li>')
  out.push('<li>ตอนที่มีเสียงแต่ไม่มีภาพ</li>')
  out.push('<li>โฟลเดอร์ drop ที่ระบบทิ้งแล้วแต่ยังมีไฟล์ที่ไม่อยู่ในกล่อง (ถังขยะลบถาวรใน ~30 วัน)</li>')
  out.push('<li>Media Pool จากไฟล์ .drp ล่าสุดของ Production ID บน Drive: คลิปที่คนตัดใช้ต้องมีในกล่อง · คลิปในกล่องที่ยังไม่ถูกดึงเข้า</li>')
  out.push('</ol><p>"ครบ" = ทุกคลิปที่อยู่ในกล่องมีครบชุด · การ์ด Sony ที่มี MEDIAPRO.XML รู้ได้ถึงคลิปที่หายทั้งชุด ส่วนกล้องอื่น/การ์ดที่ไม่มี MEDIAPRO รู้ได้ต่อเมื่อคลิปนั้นอยู่ใน Media Pool · ระบบดูชื่อ ขนาด md5 ไม่ได้เปิดไฟล์ และมองไม่เห็น NAS (ตรวจ NAS ด้วยมือตาม MEDIAPOOL-CHECK.md)</p>')
  out.push(`<p>ระบบ probook เขียนเอกสารนี้เอง — แก้ในนี้จะถูกเขียนทับ · ตรวจซ้ำทุกวัน ~13:00 น. จนงานถ่ายเกิน 30 วัน (หลังจากนั้นผลค้างที่วัน "ตรวจเมื่อ" ท้ายเอกสาร) · เอกสารเปลี่ยนเมื่อผลเปลี่ยน หรืออย่างน้อยทุก 7 วัน · แอดมินสั่งตรวจใหม่: ${esc(meta.appUrl)}/api/internal/footage-integrity/run?codes=${esc(encodeURIComponent(c.bookingCode))}&amp;docs=1</p>`)

  const body = out.join('\n')
  const hash = createHash('sha1').update(DOC_TEMPLATE).update(body).digest('hex')
  const html = `<html><head><meta charset="utf-8"></head><body>\n${body}\n<p>ตรวจเมื่อ ${esc(thaiDate(meta.checkedAt, true))}</p>\n</body></html>`
  return { html, hash }
}

/**
 * Keep one `_FOOTAGE-CHECK` Doc per box in step with `hash`. Dry-run and real
 * walk the SAME path — every read and every decision — and part only at the
 * write itself (bug class: a preview that does not match the run).
 */
export async function syncCheckDoc(o: {
  boxId: string; html: string; hash: string; write: boolean; now: Date
  /** null = safe to write · string = why this box must not get a Doc */
  blocked: string | null
}): Promise<BoxCheck['doc']> {
  try {
    const docs = await findFootageCheckDocs(o.boxId)
    const ours = docs.filter(d => d.ours)
    if (!ours.length && docs.length) return { action: 'skipped', url: docs[0].webViewLink, note: 'มีเอกสารชื่อนี้ที่คนสร้างเอง — ไม่เขียนทับ' }
    const keep = ours[ours.length - 1] ?? null
    const known = { id: keep?.id ?? null, announced: keep?.announced ?? null }
    // Extra copies of OUR Doc (a retried create, or a manual run racing the worker) are
    // collapsed on every pass, not only when the content changes.
    const trashDupes = async (): Promise<string | undefined> => {
      const dupes = ours.slice(0, -1)
      if (!dupes.length || o.blocked) return undefined
      if (!o.write) return `จะทิ้งเอกสารซ้ำ ${dupes.length} ฉบับ`
      let failed: string | undefined
      for (const d of dupes) {
        try { await trashDriveItem(d.id) } catch (e: any) { failed = `ทิ้งเอกสารซ้ำไม่ได้: ${e?.message || e}` }
      }
      return failed
    }
    const stale = !keep?.writtenAt || o.now.getTime() - Date.parse(keep.writtenAt) > DOC_REFRESH_MS
    const plan = !keep ? 'create' : keep.hash !== o.hash ? 'update' : stale ? 'refresh' : null
    if (!plan) {
      const note = await trashDupes()
      return { action: 'unchanged', url: keep!.webViewLink, ...known, ...(note ? { note } : {}) }
    }
    if (o.blocked) return { action: 'skipped', url: keep?.webViewLink ?? null, note: o.blocked, ...known }
    if (plan === 'create') {
      // Never create outside the footage drive: a Doc inside a landing folder makes it
      // "not a shell" and video-merge's fast path then moves the whole skeleton (v1.150.2).
      const tree = await classifyFootageTreeFolder(o.boxId)
      if (tree !== 'in-tree') return { action: 'skipped', url: null, note: `กล่องไม่อยู่ในไดรฟ์ฟุตเทจ (${tree}) — ไม่สร้างเอกสาร` }
    }
    if (!o.write) {
      const note = await trashDupes()
      return { action: `would-${plan}` as DocAction, url: keep?.webViewLink ?? null, ...known, ...(note ? { note } : {}) }
    }
    const id = await writeFootageCheckDoc({ folderId: o.boxId, existingId: keep?.id ?? null, html: o.html, hash: o.hash, writtenAt: o.now.toISOString() })
    const note = await trashDupes()
    return {
      action: plan === 'create' ? 'created' : plan === 'update' ? 'updated' : 'refreshed',
      url: keep?.webViewLink ?? `https://docs.google.com/document/d/${id}/edit`,
      id, announced: known.announced,
      ...(note ? { note } : {}),
    }
  } catch (e: any) {
    return { action: 'failed', url: null, note: e?.message || String(e) }
  }
}

// ── a page of boxes ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 3_600_000
const bkkDay = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd) + n * DAY_MS).toISOString().slice(0, 10)

export interface FootageCheckPage {
  skipped: boolean
  reason?: string
  since: string | null
  until: string | null
  offset: number
  nextOffset: number | null
  total: number
  docs: boolean
  /** bookings in the window with no box link (not photo-only) — NOT checked, and said so */
  noBox: number
  noBoxCodes: string[]
  boxes: BoxCheck[]
}

/**
 * One page of the daily check. The worker walks pages (offset → nextOffset)
 * with the same days/codes, so every booking in the window is checked; the
 * deadline keeps one request inside the proxy/worker budget, and `nextOffset`
 * counts what was actually processed, so a short page drops nothing.
 */
export async function scanFootagePage(opts: {
  days?: number; codes?: string[]; projects?: string[]; offset?: number; limit?: number
  docs?: boolean; deadlineMs?: number; now?: Date
} = {}): Promise<FootageCheckPage> {
  const now = opts.now ?? new Date()
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 25)))
  const docs = !!opts.docs
  const base: FootageCheckPage = { skipped: false, since: null, until: null, offset, nextOffset: null, total: 0, docs, noBox: 0, noBoxCodes: [], boxes: [] }
  if (!hasDriveCredentials()) return { ...base, skipped: true, reason: 'no Drive credentials' }

  const codes = (opts.codes || []).map(c => c.trim().toUpperCase()).filter(Boolean)
  const projects = (opts.projects || []).map(c => c.trim().toUpperCase()).filter(Boolean)
  const today = bkkDay(now)
  // Today's shoot has not finished uploading at 13:00 — the window ends yesterday (BKK).
  const until = addDays(today, -1)
  const since = addDays(today, -Math.max(1, opts.days ?? 30))
  const targeted = codes.length > 0 || projects.length > 0
  const where = {
    deletedAt: null,
    status: { not: 'CANCELLED' as const },
    bookingCode: codes.length ? { in: codes } : { not: null },
    ...(projects.length ? { projectId: { in: projects } } : {}),
    // A Production ID covers future shoots too — nothing to check there yet. Codes stay exact.
    ...(projects.length && !codes.length ? { shootDate: { lte: new Date(until) } } : {}),
    // A multi-day shoot that ENDED in the window is in the window.
    ...(targeted ? {} : { OR: [
      { shootDate: { gte: new Date(since), lte: new Date(until) } },
      { shootEndDate: { gte: new Date(since), lte: new Date(until) } },
    ] }),
  }
  const total = await prisma.booking.count({ where })
  const rows = await prisma.booking.findMany({
    where,
    select: { bookingCode: true, projectId: true, projectName: true, shootDate: true, shootEndDate: true, driveFolders: true },
    orderBy: [{ shootDate: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
  })

  const started = Date.now()
  const deadline = opts.deadlineMs ?? 240_000
  const drp = new Map<string, Promise<DrpLoad>>()
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'
  // Rows START in order and a new one never starts after the deadline, so what was
  // processed is always a prefix and nextOffset drops nothing. A Sony box walk is
  // ~100 folder lists (10–15 s); three boxes at a time ≈ 1,800 Drive reads/min.
  const results: Array<BoxCheck | null> = []
  let processed = 0
  const next = async (): Promise<void> => {
    while (processed < rows.length && (processed === 0 || Date.now() - started <= deadline)) {
      const idx = processed++
      const b = rows[idx]
      const folders = (b.driveFolders || {}) as Record<string, unknown>
      const boxId = typeof folders.box === 'string' ? folders.box : null
      if (!b.bookingCode || !boxId) {
        if (typeof folders.photo !== 'string') {
          base.noBox++
          if (b.bookingCode && base.noBoxCodes.length < 10) base.noBoxCodes.push(b.bookingCode)
        }
        results[idx] = null
        continue
      }
      const projectId = b.projectId?.trim() || null
      if (projectId && !drp.has(projectId)) drp.set(projectId, loadDrp(projectId))
      results[idx] = await checkBox({
        code: b.bookingCode, boxId, projectId, projectName: b.projectName, shootDate: b.shootDate.toISOString().slice(0, 10),
        lastDay: lastShootDay(b).toISOString().slice(0, 10),
        landingId: typeof folders.landing === 'string' ? folders.landing : undefined,
        drp: projectId ? drp.get(projectId)! : null, docs, now, today, appUrl,
      })
    }
  }
  await Promise.all([next(), next(), next()])
  base.boxes = results.filter((r): r is BoxCheck => !!r)
  return { ...base, since: targeted ? null : since, until: targeted ? null : until, total, nextOffset: offset + processed < total ? offset + processed : null }
}

async function checkBox(o: {
  code: string; boxId: string; projectId: string | null; projectName: string | null; shootDate: string; lastDay: string
  landingId: string | undefined; drp: Promise<DrpLoad> | null; docs: boolean; now: Date; today: string; appUrl: string
}): Promise<BoxCheck> {
  const errors: string[] = []
  // Ageing uses the LAST shoot day — a multi-day shoot is not over on day one.
  const waiting = (Date.parse(o.today) - Date.parse(o.lastDay)) / DAY_MS < GRACE_DAYS

  let box: Awaited<ReturnType<typeof getDriveItemState>> = null
  let boxRead = true
  try { box = await getDriveItemState(o.boxId) } catch (e: any) { boxRead = false; errors.push(`อ่านกล่องไม่ได้: ${e?.message || e}`) }
  if (boxRead && !box) errors.push('กล่องที่ผูกไว้ไม่มีแล้ว (ถูกลบถาวร)')
  if (box?.trashed) errors.push('กล่องที่ผูกไว้อยู่ในถังขยะ')

  let files: DriveFile[] = []
  let readable = !!box && !box.trashed
  if (readable) {
    try {
      files = await listFilesRecursive(o.boxId, { maxFiles: MAX_BOX_FILES })
      if (files.length >= MAX_BOX_FILES) { readable = false; errors.push(`ไฟล์เกิน ${MAX_BOX_FILES} — ตรวจไม่ครบ`) }
    } catch (e: any) {
      readable = false
      errors.push(`อ่านไฟล์ในกล่องไม่ได้: ${e?.message || e}`)
    }
  }

  const issues: FootageIssue[] = []
  let stranded: StrandedSummary | null = null
  let mediaPool: MediaPoolLine | null = null
  if (readable) {
    issues.push(...findIssues(o.code, files))
    try {
      const mc = mediaproCheck(files, await loadMediaproCards(files))
      // v1.258 — say WHERE a missing file went (a wrong drop folder, another box). Hint only:
      // a lookup that fails just leaves the line without a location — the issue itself stands.
      // Only names unique to one clip (FX6/FX3 reel+date): C0001 restarts on every card, so a
      // match elsewhere is somebody else's clip. Sorted, so the same ten are asked every run.
      const foundAt = new Map<string, string>()
      const names = [...new Set(mc.missing.map(m => m.file.split('/').pop() || ''))].filter(n => n && hasUniqueClipName(n)).sort().slice(0, 10)
      for (const name of names) {
        try { const w = await locateFileByName(name, o.boxId); if (w) foundAt.set(name, w) }
        catch (e: any) { console.warn(`[footage-check] locate ${name} failed (hint only): ${e?.message || e}`) }
      }
      issues.push(...mediaproIssues(o.code, mc, foundAt))
    } catch (e: any) { errors.push(`อ่าน MEDIAPRO.XML ไม่ได้: ${e?.message || e}`) }
    const landing = await probeTrashedLanding(o.code, o.landingId, files)
    issues.unshift(...landing.issues)
    stranded = landing.stranded
    if (landing.error) errors.push(landing.error)
    if (o.drp) {
      const mp = mediaPoolLine(await o.drp, o.code, o.shootDate, files)
      mediaPool = mp.line
      issues.push(...mp.issues)
      if (mp.line.status === 'error' && mp.line.error) errors.push(mp.line.error)
    }
  }

  const state = boxState({ readable, files, issues, waiting })
  const counts: BoxCheck['counts'] = {}
  for (const i of issues) counts[i.kind] = (counts[i.kind] || 0) + 1
  const real = files.filter(f => isRealFootage(f) && !isQuarantined(f))
  const bytes = real.reduce((s, f) => s + (f.size || 0), 0)

  // Where the Doc may go: our own live box only. A shared AGN project box would
  // flip between bookings every run; a box whose name is not this booking's is
  // exactly the link folder-integrity already refuses to touch.
  let blocked: string | null = null
  if (!box || box.trashed) blocked = 'กล่องอ่านไม่ได้หรืออยู่ในถังขยะ'
  else if (!folderNameMatchesCode(box.name, o.code)) blocked = `ชื่อกล่อง "${box.name}" ไม่ใช่ของคิวนี้ — ไม่เขียนเอกสาร`
  else {
    const sharing = await prisma.booking.count({ where: { deletedAt: null, driveFolders: { path: ['box'], equals: o.boxId } } })
    if (sharing > 1) blocked = `กล่องนี้ผูกกับ ${sharing} ใบจอง — ไม่เขียนเอกสาร`
  }

  let doc: BoxCheck['doc'] = { action: 'skipped', url: null, note: blocked || undefined }
  if (box && !box.trashed) {
    const { html, hash } = renderCheckDoc({
      bookingCode: o.code, projectId: o.projectId, projectName: o.projectName, shootDate: o.shootDate,
      state, waiting, files: real.length, bytes, issues, rows: groupRows(files, issues), stranded, mediaPool, errors,
    }, { checkedAt: o.now, appUrl: o.appUrl })
    doc = await syncCheckDoc({ boxId: o.boxId, html, hash, write: o.docs, now: o.now, blocked })
  }

  return {
    bookingCode: o.code, projectId: o.projectId, shootDate: o.shootDate, boxId: o.boxId,
    state, waiting, files: real.length, bytes, counts, issues: issues.slice(0, 20),
    stranded, mediaPool, issueKey: issueKey(issues, waiting), doc, errors,
  }
}

// ── the daily summary (one chat message per run, however many pages) ────────

export interface RunSummary {
  boxes: BoxCheck[]
  noBox?: number
  noBoxCodes?: string[]
  since?: string | null
  until?: string | null
  docs?: boolean
  /** set when the run did not reach the end (a page failed / made no progress) */
  failure?: string | null
}

/** Discord cuts a message at 1990 chars and still answers 200 — stay under it with room to spare. */
const CHAT_BUDGET = 1900

/**
 * News = a box whose live issues differ from what last reached chat. A Doc
 * rewrite (new .drp save, new bytes) is not news; a Doc written while the chat
 * send failed is still news tomorrow (a record is not a delivery).
 */
export function isNews(b: BoxCheck): boolean {
  if (b.state !== 'issues') return false
  return !b.doc.id || b.doc.announced !== b.issueKey
}

/** Discord/Lark body. Empty string when there is nothing anyone needs to read. */
export function formatRunSummary(s: RunSummary): string {
  const boxes = s.boxes || []
  const by = (st: BoxState) => boxes.filter(b => b.state === st).length
  const stranded = boxes.filter(b => b.stranded)
  const live = boxes.filter(b => b.state === 'issues')
  const news = live.filter(isNews)
  const unreadable = boxes.filter(b => b.state === 'unreadable')
  const docFailed = boxes.filter(b => b.doc.action === 'failed')
  const partial = boxes.filter(b => b.state !== 'unreadable' && b.errors.length)
  if (!stranded.length && !news.length && !unreadable.length && !docFailed.length && !partial.length && !s.failure) return ''

  const range = s.since && s.until ? ` (ถ่าย ${thaiDate(new Date(s.since))} – ${thaiDate(new Date(s.until))})` : ''
  const noBox = s.noBox || 0
  const head = [
    `🎞️ ตรวจฟุตเทจรายวัน · ${boxes.length} กล่อง${noBox ? ` · ไม่มีกล่องผูก ${noBox} ใบ (ไม่ได้ตรวจ${s.noBoxCodes?.length ? `: ${s.noBoxCodes.slice(0, 5).join(', ')}` : ''})` : ''}${range}`,
    `✅ ครบ ${by('ok')} · ⚠️ ต้องตามต่อ ${live.length} · ⏳ รอต้นฉบับ ${by('waiting')} · ℹ️ ไม่ใช่การ์ด Sony ${by('no-sony')} · ⬜ ว่าง ${by('empty')} · ❔ อ่านไม่ได้ ${unreadable.length}`,
  ]
  // Run-level lines go first: they must survive the per-box detail being cut.
  const run: string[] = []
  if (s.failure) run.push(`⚠️ รอบนี้ตรวจไม่ครบ: ${s.failure}`)
  if (unreadable.length) run.push(`❔ อ่านกล่องไม่ได้ ${unreadable.length} ใบ: ${unreadable.slice(0, 5).map(b => `${b.bookingCode} (${(b.errors[0] || '?').slice(0, 80)})`).join(' · ')}`)
  if (partial.length) run.push(`⚠️ ตรวจบางส่วนไม่ได้ ${partial.length} ใบ: ${partial.slice(0, 3).map(b => `${b.bookingCode} (${b.errors[0].slice(0, 80)})`).join(' · ')}`)
  const d = (a: DocAction) => boxes.filter(b => b.doc.action === a).length
  run.push(s.docs
    ? `📄 _FOOTAGE-CHECK: สร้าง ${d('created')} · อัปเดต ${d('updated') + d('refreshed')} · เหมือนเดิม ${d('unchanged')} · ข้าม ${d('skipped')} · ล้ม ${docFailed.length}`
    : `📄 _FOOTAGE-CHECK: ยังไม่เปิดเขียน (จะสร้าง ${d('would-create')} · อัปเดต ${d('would-update') + d('would-refresh')})`)
  if (docFailed.length) run.push(`   ล้ม: ${docFailed.slice(0, 3).map(b => `${b.bookingCode} (${(b.doc.note || '').slice(0, 80)})`).join(' · ')}`)
  const tail = stranded.length || live.length
    ? ['', '⚠️ อย่าเพิ่งลบอะไรจนกว่าจะเทียบกับการ์ดต้นทาง — ขนาดไฟล์ไม่ใช่เครื่องตัดสินว่าตัวไหนคือตัวจริง']
    : []

  const size = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0)
  let room = CHAT_BUDGET - size(head) - size(run) - size(tail) - 2
  const detail: string[] = []
  const add = (block: string[], more: () => string) => {
    if (size(block) + 80 <= room) { detail.push(...block); room -= size(block); return true }
    const m = more()
    if (size([m]) <= room) { detail.push(m); room -= size([m]) }
    return false
  }
  if (stranded.length) {
    add(['', '🚨 ไฟล์ค้างในถังขยะ (ยังไม่อยู่ในกล่อง · จะถูกลบถาวร):'], () => `🚨 ไฟล์ค้างในถังขยะ ${stranded.length} ใบ`)
    for (let i = 0; i < stranded.length; i++) {
      const b = stranded[i]
      const line = `• ${b.bookingCode} — ${b.stranded!.files} ไฟล์ ${gb(b.stranded!.bytes)}${b.stranded!.purgeAfter ? ` · ลบถาวรราว ${thaiDate(new Date(b.stranded!.purgeAfter))}` : ''}`
      if (!add([line], () => `• …อีก ${stranded.length - i} ใบ`)) break
    }
  }
  if (news.length) {
    const stale = live.length - news.length
    add(['', `⚠️ ต้องตามต่อ (ใหม่/เปลี่ยน ${news.length} ใบ${stale ? ` · ค้างเดิม ${stale} ใบ ดูในเอกสารของกล่อง` : ''}):`], () => `⚠️ ต้องตามต่อ ใหม่/เปลี่ยน ${news.length} ใบ`)
    for (let i = 0; i < news.length; i++) {
      const b = news[i]
      const counts = (Object.entries(b.counts) as Array<[FootageIssueKind, number]>)
        .filter(([k]) => !(b.waiting && WAITING_KINDS.has(k)))
        .map(([k, n]) => `${ISSUE_LABEL[k]} ${n}`).join(' · ')
      const block = [`• ${b.bookingCode} — ${counts}${b.doc.url ? ` · ${b.doc.url}` : ''}`,
        ...b.issues.filter(x => isLive(x, b.waiting)).slice(0, 2).map(x => `   – [${ISSUE_LABEL[x.kind]}] ${x.detail.slice(0, 140)}${x.hint ? ` · 🔎 อยู่ที่ ${x.hint.slice(0, 80)}` : ''}`)]
      if (!add(block, () => `• …อีก ${news.length - i} ใบ ดูใน _FOOTAGE-CHECK ของแต่ละกล่อง`)) break
    }
  }
  return [...head, ...run, ...detail, ...tail].join('\n')
}
