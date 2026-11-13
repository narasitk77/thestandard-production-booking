/**
 * v1.286 — keep Episode.episodeId in step with the Producer Dashboard.
 *
 * WHERE EPISODE CODES COME FROM (found 2026-11-11, not documented anywhere before):
 * for Content Agency work the Dashboard's "PD <name>" tabs own the codes
 * (PP-26-056-L01, …). A booking only *selects* them (dashboard-episodes.ts) and copies the
 * string into its own Episode row. Nothing ever updated that copy, so when the Dashboard
 * renamed PP-26-056-H01 → S01 (4 Nov) the bookings kept H01, the sheet's "Episode IDs"
 * column (which PMDC's daily sync joins on) kept H01, and PMDC logged
 * "Unresolved Episode 'PP-26-056-H01'" every night. The ID spine was designed to be
 * immutable (Nat + ปุ๊ก, 1 Jun) — a rename is an exception that must never be silent.
 *
 * Two halves:
 *   1. planDrift / driftReport — diff the codes bookings hold against the Dashboard.
 *   2. renameEpisodeCode       — the one safe way to change a code everywhere it lives.
 *
 * WHAT THE DIFF CAN AND CANNOT KNOW: the codes alone say "H01 is gone", never "H01 became S01".
 * v1.289 — Nat's rule (13 Nov): rename AUTOMATICALLY only when it matches ปุ๊ก's database; anything
 * else goes to Nat for approval WITH the reason. The one record of ปุ๊ก's database we can read is the
 * PD tabs' "Previous IDs" column: PMDC's ep-retype writes the old code there in the same job that
 * renames the Lark Deliverable in place (pmdc-ops automation/impact/keys.yaml: PD col C and Lark are
 * paired sources; Previous IDs added 11 Nov at our request). So a pair is a `rename-candidate` only
 * when exactly ONE Dashboard row of the project lists the vanished code in its Previous IDs.
 * Two rows listing it = `pmdc-conflict`. No record = the label heuristic below, which now only
 * SUGGESTS: exactly ONE code vanished, exactly ONE Dashboard code held by no booking, the SAME
 * episode number, the Dashboard row has its OWN label (not empty, "-", or the project name) that no
 * other episode carries, and every booking row stored exactly that label → `label-only` (strong, but
 * not ปุ๊ก's record); weaker → `weak-label` / `label-mismatch` / `renumbered`, with the pair named
 * (`suggested`) when there is exactly one of each. Renames before 11 Nov have no Previous IDs entry
 * (PP-26-074 H→S, 19 Oct, was applied by hand on 13 Nov from PMDC's own records).
 * HALF-DONE RETYPE: ep-retype writes PD col C + Previous IDs BEFORE the Lark record and stops (no undo) if a later
 * step fails, so a record can exist while Lark still holds the old code. Its Drive step (renaming the project's EP
 * folder "<code> · …") runs AFTER Lark, so in that state a folder named with the old code still exists and the
 * Drive-folder guard in doRename refuses the rename (reported, ok:false). Projects with no EP folder are not covered.
 * KNOWN SILENT GAP: the frozen legacy "_EPs" tab (and a stale duplicate PD row) is unioned into the
 * Dashboard list, so a renamed code that still sits there looks alive — that drift is NOT reported.
 * Loud ones: a Dashboard cell parseEpisodeTabs rejects (zero-width space, lowercase) shows up as a
 * vanished code; a sandbox sheet override (isUsingSandboxSheet) refuses everything.
 *
 * ORDER OF EFFECTS in renameEpisodeCode (same rule as regenerate-booking-id.ts): every external
 * write that can be repeated harmlessly runs BEFORE the DB commit — the sheet cell, then the
 * `_SHOOT.txt` marker the footage crawler reads — and a genuine error aborts WITHOUT committing:
 * the DB still holds the old code, so a re-run recomputes the same plan and retries. The audit rows
 * are written INSIDE the commit (no audit = no rename). Nothing runs after the commit.
 * Not done on purpose: the booking's Calendar event (the only updater rewrites time and location
 * too — it would undo an event someone moved by hand — and its failure path re-sends with
 * sendUpdates:'all'; the description catches up at the booking's next edit), syncBookingOT
 * (move-outlet's reasoning: no pay field changes, only DRAFT labels) and Drive folder names (AGN
 * episode folders lead with the code; a rename is REFUSED while one exists).
 */
import { prisma } from './db'
import { EPISODE_ORDER } from './episode-order'
import { updateBookingRow, type SheetUpdateResult } from './google-sheets'
import { findFoldersByCode } from './google-drive'
import { refreshShootMarker } from './shoot-marker'
import { listAllDashboardEpisodes } from './dashboard-episodes'
import { isUsingSandboxSheet } from './google-config'

/** A Dashboard episode code (same grammar as projects.ts EPISODE_ID_RE, with the project captured). */
export const PROJECT_EPISODE_RE = /^(PP-\d{2}-\d{3})-[A-Z]\d{2,}$/
const projectOf = (code: string): string | null => PROJECT_EPISODE_RE.exec(code)?.[1] ?? null
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const numberOf = (code: string) => /(\d+)$/.exec(code)?.[1] ?? ''

/** Per-run caps for the automatic path. More than this is not routine drift — it is a bad read or a bulk edit. */
export const MAX_AUTO_RENAMES = 5
export const MAX_ORPHANS_FOR_AUTO = 10
/** A run that has not settled after this long is treated as dead, so one hung call cannot wedge the daily job. */
const INFLIGHT_TTL_MS = 15 * 60_000

/** The title a booking stores for a Dashboard episode — create-booking.ts / link-episodes.ts rule: the EP label, else the project name. */
export const dashLabel = (e: { ep?: string | null; projectName?: string | null }): string =>
  e.ep && e.ep !== '-' ? e.ep : (e.projectName ?? '')
/** True when the Dashboard row carries a label of its own (not empty / "-" / the project-name fallback). */
export const hasOwnLabel = (e: { ep?: string | null; projectName?: string | null }): boolean =>
  !!e.ep && e.ep !== '-' && norm(e.ep) !== norm(e.projectName ?? '')

export type EpRow = {
  id: string
  episodeId: string
  title: string
  bookingId: string
  bookingCode: string | null
  status: string
  deleted: boolean
  uploadCount: number
}
/** previousIds = the row's "Previous IDs" cell (PMDC's record of a rename); absent = none recorded */
export type DashEp = { episodeId: string; label: string; ownLabel: boolean; previousIds?: string[] }

// ── 1. drift ──────────────────────────────────────────────────────────────────

export type DriftKind = 'rename-candidate' | 'ambiguous' | 'orphan-only'
export type DriftReason = 'label-only' | 'pmdc-conflict' | 'weak-label' | 'label-mismatch' | 'renumbered' | 'several' | 'no-unclaimed'
export type Drift = {
  project: string
  kind: DriftKind
  /** why it is not a rename-candidate */
  reason?: DriftReason
  /** codes bookings hold that the Dashboard no longer lists */
  orphans: string[]
  /** Dashboard codes of the project that no booking holds */
  unclaimed: string[]
  /** booking codes holding an orphan */
  bookings: string[]
  /** only for rename-candidate: PMDC recorded it (Previous IDs) — safe to apply automatically */
  candidate?: { from: string; to: string }
  /** one vanished + one unclaimed but not trusted automatically: the likely pair, for a human to confirm */
  suggested?: { from: string; to: string }
  /** every code the Dashboard lists for the project — so a human can decide without opening the sheet */
  dashboardCodes?: string[]
  /** only for pmdc-conflict: the Dashboard rows whose Previous IDs all list the vanished code */
  recordedIn?: string[]
}

/**
 * Pure. `rows` = Episode rows (any booking), `dash` = every code the Dashboard lists.
 * Soft-deleted bookings COUNT: their sheet rows stay (status CANCELLED) and PMDC's sync processes
 * CANCELLED rows too, so a stale code there is still an "Unresolved Episode" every night.
 * An empty `dash` is a caller bug (unreadable Dashboard), not "everything is orphaned".
 */
export function planDrift(rows: EpRow[], dash: DashEp[]): Drift[] {
  if (dash.length === 0) throw new Error('planDrift: empty Dashboard list — refusing to treat it as "all orphaned"')
  const dashBy = new Map<string, Map<string, DashEp>>()   // project → code → row
  for (const d of dash) {
    const p = projectOf(d.episodeId)
    if (p) dashBy.set(p, (dashBy.get(p) ?? new Map<string, DashEp>()).set(d.episodeId, d))
  }
  const held = new Map<string, Map<string, EpRow[]>>()    // project → code → rows
  for (const r of rows) {
    const p = projectOf(r.episodeId)
    if (!p) continue
    const byCode = held.get(p) ?? new Map<string, EpRow[]>()
    byCode.set(r.episodeId, [...(byCode.get(r.episodeId) ?? []), r])
    held.set(p, byCode)
  }
  const out: Drift[] = []
  for (const [project, byCode] of Array.from(held.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const d = dashBy.get(project) ?? new Map<string, DashEp>()
    const allOrphans = Array.from(byCode.keys()).filter(c => !d.has(c)).sort()
    if (allOrphans.length === 0) continue
    const bookingsOf = (codes: string[]) =>
      Array.from(new Set(codes.flatMap(c => byCode.get(c)!.map(r => r.bookingCode ?? r.bookingId)))).sort()
    const dashboardCodes = Array.from(d.keys()).sort()
    const allUnclaimed = dashboardCodes.filter(c => !byCode.has(c))
    // ปุ๊ก's record first (see the header): the vanished code listed in exactly ONE row's Previous IDs
    const recordedTo = new Set<string>()
    const orphans: string[] = []
    for (const o of allOrphans) {
      const tos = Array.from(d.values()).filter(x => x.previousIds?.includes(o)).map(x => x.episodeId)
      const one = { project, orphans: [o], unclaimed: allUnclaimed, bookings: bookingsOf([o]) }
      if (tos.length === 1) {
        out.push({ ...one, kind: 'rename-candidate', candidate: { from: o, to: tos[0] } })
        recordedTo.add(tos[0])
      } else if (tos.length > 1) {
        out.push({ ...one, kind: 'ambiguous', reason: 'pmdc-conflict', recordedIn: tos.sort(), dashboardCodes })
      } else orphans.push(o)
    }
    if (orphans.length === 0) continue
    const unclaimed = allUnclaimed.filter(c => !recordedTo.has(c))
    const base = { project, orphans, unclaimed, bookings: bookingsOf(orphans), dashboardCodes }
    if (orphans.length === 1 && unclaimed.length === 1) {
      const pair = { from: orphans[0], to: unclaimed[0] }
      const target = d.get(pair.to)!
      const want = norm(target.label)
      const titlesMatch = byCode.get(pair.from)!.every(r => norm(r.title) === want)
      const distinctive = target.ownLabel && Array.from(d.values()).filter(x => norm(x.label) === want).length === 1
      const sameNumber = numberOf(pair.from) === numberOf(pair.to)
      // no record from PMDC: even the strongest label match only goes to Nat (label-only)
      const reason: DriftReason = !titlesMatch ? 'label-mismatch' : !distinctive ? 'weak-label' : !sameNumber ? 'renumbered' : 'label-only'
      out.push({ ...base, kind: 'ambiguous', reason, suggested: pair })
    } else if (unclaimed.length === 0) {
      out.push({ ...base, kind: 'orphan-only', reason: 'no-unclaimed' })
    } else {
      out.push({ ...base, kind: 'ambiguous', reason: 'several' })
    }
  }
  return out
}

// ── 2. rename ─────────────────────────────────────────────────────────────────

/**
 * Pure. Why a rename must not run. `fromRows` = rows holding `from`, `toRows` = rows already holding `to`.
 * `to` held by OTHER bookings is normal (Episode.episodeId is not unique — one episode, many shoots);
 * only a booking holding BOTH codes would end up with the same code twice.
 * No row holds `from` is not decided here: a repeat run and a typo look the same until the audit says which.
 */
export function planRename(from: string, to: string, fromRows: EpRow[], toRows: EpRow[]):
  { blockers: string[]; nothingToDo: boolean } {
  const blockers: string[] = []
  const stop = () => ({ blockers, nothingToDo: false })
  if (from === to) { blockers.push('รหัสเดิมกับรหัสใหม่เหมือนกัน'); return stop() }
  if (!projectOf(from) || !projectOf(to)) { blockers.push('รูปแบบรหัสต้องเป็นรหัสตอนของ Dashboard (PP-YY-NNN-XNN)'); return stop() }
  if (projectOf(from) !== projectOf(to)) { blockers.push('คนละโปรเจกต์ — ไม่รองรับการย้ายตอนข้ามโปรเจกต์'); return stop() }
  if (fromRows.length === 0) {
    if (toRows.length > 0) return { blockers, nothingToDo: true }
    blockers.push(`ไม่พบตอน ${from} ในใบจองใด ๆ และไม่มี ${to} ด้วย — พิมพ์รหัสผิดหรือเปล่า?`)
    return stop()
  }

  const label = (r: EpRow) => r.bookingCode ?? r.bookingId
  const perBooking = new Map<string, number>()
  for (const r of fromRows) perBooking.set(r.bookingId, (perBooking.get(r.bookingId) ?? 0) + 1)
  const dup = fromRows.filter(r => (perBooking.get(r.bookingId) ?? 0) > 1)
  if (dup.length) blockers.push(`ใบ ${Array.from(new Set(dup.map(label))).join(', ')} มีรหัส ${from} ซ้ำหลายตอน — เปลี่ยนแล้วจะชนกันเอง ต้องแก้มือ`)
  const fromBookings = new Set(fromRows.map(r => r.bookingId))
  const both = toRows.filter(r => fromBookings.has(r.bookingId))
  if (both.length) blockers.push(`ใบ ${Array.from(new Set(both.map(label))).join(', ')} มีทั้ง ${from} และ ${to} อยู่แล้ว — เปลี่ยนแล้วจะมีรหัสเดียวกันสองตอนในใบเดียว ต้องแก้มือ`)
  const withFiles = fromRows.filter(r => r.uploadCount > 0)
  if (withFiles.length) blockers.push(`ตอนในใบ ${Array.from(new Set(withFiles.map(label))).join(', ')} มีไฟล์อัปโหลดผูกอยู่ — ทำมือ (ชื่อไฟล์/โฟลเดอร์อาจอิงรหัสเดิม)`)
  if (fromRows.some(r => r.bookingCode === from)) blockers.push('รหัสนี้ตรงกับรหัสใบจองเอง — ใช้ regenerate-id ไม่ใช่เส้นนี้')
  return { blockers, nothingToDo: false }
}

export type BookingPlan = { bookingCode: string | null; status: string; deleted: boolean; sheetEpisodeIds: string }
export type Effect = { bookingCode: string | null; sheet: SheetUpdateResult | 'n/a'; marker: 'updated' | 'not-found' | 'skipped' | 'n/a' }
export type RenameResult = {
  ok: boolean
  dryRun: boolean
  from: string
  to: string
  nothingToDo: boolean
  alreadyRenamed: boolean
  blockers: string[]
  /** every booking the rename touches (soft-deleted ones included: their sheet row stays and PMDC reads it) */
  bookings: BookingPlan[]
  /** other bookings that already hold `to` (same episode shot elsewhere) — informational */
  alsoHeldBy: string[]
  effects: Effect[]
  warnings: string[]
  /** what this deliberately does not touch, so nobody assumes it did */
  notes: string[]
  /** true once the DB transaction (rename + audit rows) has committed */
  committed?: boolean
  error?: string
}

const NOTES = [
  'ปฏิทิน: ไม่แก้คำอธิบาย event โดยตั้งใจ (ตัวแก้ที่มีเขียนทับเวลา/สถานที่ด้วย) — จะตามทันเมื่อใบถูกแก้ครั้งถัดไป',
  'OT: ป้ายของร่าง OT ยังเป็นรหัสเดิมจนกว่าใบจะถูก sync OT ครั้งถัดไป (ไม่กระทบยอดเงิน)',
]

const rowSelect = {
  id: true, episodeId: true, title: true, bookingId: true,
  booking: { select: { bookingCode: true, status: true, deletedAt: true } },
  _count: { select: { uploads: true } },
} as const

async function loadRows(where: { episodeId: string | { startsWith: string } }): Promise<EpRow[]> {
  const eps = await prisma.episode.findMany({ where, select: rowSelect })
  return eps.map(e => ({
    id: e.id, episodeId: e.episodeId, title: e.title, bookingId: e.bookingId, bookingCode: e.booking.bookingCode,
    status: e.booking.status, deleted: !!e.booking.deletedAt, uploadCount: e._count.uploads,
  }))
}

const bookingInclude = {
  outlet: true,
  program: true,
  episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
} as const

const failed = (o: { from: string; to: string; dryRun: boolean }, error: string): RenameResult => ({
  ok: false, dryRun: o.dryRun, from: o.from, to: o.to, nothingToDo: false, alreadyRenamed: false,
  blockers: [], bookings: [], alsoHeldBy: [], effects: [], warnings: [], notes: [], error,
})

// A retry of the same request (busybox wget re-sends after a slow read) JOINS the run in flight and gets
// the same answer. Real writes are serialised on one chain: two different renames touching one booking
// must not each write the sheet from their own stale snapshot (last write wins = one code silently lost).
const inflight = new Map<string, { p: Promise<RenameResult>; at: number }>()
let writeChain: Promise<unknown> = Promise.resolve()
/** The real write currently executing — a Google call with no timeout can hang it forever, so a later write that
 *  finds it older than the TTL is REFUSED loudly instead of queueing behind it (only a restart clears a hang). */
let writeHead: { since: number; label: string } | null = null

type RenameInput = { from: string; to: string; actor: string; dryRun: boolean; dashboardCodes?: Set<string> }

/**
 * Change `from` → `to` on EVERY Episode row that holds `from` (an episode can be shot across several
 * bookings — PP-26-056-H01 sat on two), then everything derived from it. `dryRun` walks the same plan
 * and stops before the first write. `dashboardCodes` lets the automatic path reuse the snapshot it paired on.
 */
export function renameEpisodeCode(o: RenameInput): Promise<RenameResult> {
  const input = { ...o, from: o.from.trim(), to: o.to.trim() }
  const key = `${input.from}|${input.to}|${input.dryRun}`
  const running = inflight.get(key)
  if (running && Date.now() - running.at < INFLIGHT_TTL_MS) return running.p
  if (!input.dryRun && writeHead && Date.now() - writeHead.since > INFLIGHT_TTL_MS) {
    return Promise.resolve(failed(input, `คิวการแก้รหัสติดอยู่: ${writeHead.label} เริ่มเมื่อ ${new Date(writeHead.since).toISOString()} แล้วไม่จบ (เกิน 15 นาที) — รีสตาร์ตคอนเทนเนอร์แอปก่อน แล้วค่อยรันใหม่`))
  }
  const run = input.dryRun ? doRename(input) : (writeChain = writeChain.catch(() => {}).then(async () => {
    writeHead = { since: Date.now(), label: `${input.from} → ${input.to}` }
    try { return await doRename(input) } finally { writeHead = null }
  })) as Promise<RenameResult>
  const p = run.finally(() => { if (inflight.get(key)?.p === p) inflight.delete(key) })
  inflight.set(key, { p, at: Date.now() })
  return p
}

async function doRename(o: RenameInput): Promise<RenameResult> {
  const { from, to, actor, dryRun } = o
  const res: RenameResult = { ...failed(o, ''), ok: true, error: undefined }
  delete res.error
  if (isUsingSandboxSheet()) return { ...res, ok: false, blockers: ['แอปกำลังชี้ Producer Dashboard ชีททดสอบ (PRODUCER_DASHBOARD_SHEET_ID) — ไม่เทียบและไม่แก้รหัสตอนกับชีทผิดตัว'] }
  const [fromRows, toRows] = await Promise.all([loadRows({ episodeId: from }), loadRows({ episodeId: to })])
  const plan = planRename(from, to, fromRows, toRows)
  res.blockers = plan.blockers
  res.alsoHeldBy = Array.from(new Set(toRows.map(r => r.bookingCode ?? r.bookingId))).sort()
  if (plan.blockers.length) return { ...res, ok: false }
  if (plan.nothingToDo) {
    // No row holds `from` but `to` is in use: a repeat run — or a typo in `from`. Only the audit can tell.
    const done = await prisma.auditLog.findFirst({
      where: { action: 'booking.episode_renamed', AND: [{ changes: { path: ['from'], equals: from } }, { changes: { path: ['to'], equals: to } }] },
      select: { at: true },
    })
    if (done) return { ...res, nothingToDo: true, alreadyRenamed: true }
    return { ...res, ok: false, blockers: [`ไม่พบตอน ${from} ในใบจองใด ๆ และไม่พบประวัติว่าเคยเปลี่ยน ${from} → ${to} (audit เก็บ 90 วัน) — พิมพ์รหัสเดิมผิดหรือเปล่า?`] }
  }

  // The Dashboard is the source — this only follows it. A manual rename to a code the Dashboard does not
  // list would recreate the very "Unresolved Episode" it exists to fix, so it is refused (dry run too).
  let dashCodes = o.dashboardCodes
  if (!dashCodes) {
    const dash = await listAllDashboardEpisodes()
    if (!dash.ok) return { ...res, ok: false, blockers: [`อ่าน Dashboard ไม่ได้ (${dash.error}) — ยืนยันรหัสใหม่ไม่ได้ จึงไม่แก้`] }
    dashCodes = new Set(dash.episodes.map(e => e.episodeId))
  }
  if (!dashCodes.has(to)) res.blockers.push(`Dashboard ไม่มีรหัส ${to} — จะเปลี่ยนไปเป็นรหัสที่ PMDC หาไม่เจอ (พิมพ์ผิด?)`)
  if (dashCodes.has(from)) res.blockers.push(`Dashboard ยังมีรหัส ${from} อยู่ — ไม่เปลี่ยนรหัสที่ยังใช้อยู่`)

  // AGN episode folders lead with the code (outlet-folders.ts episodeLeadUsesId) and live under a project box
  // shared by bookings. Renaming them is not built: with one present, folder-integrity would create an empty
  // duplicate under the new code and the footage would sit under the old one. Verified from Drive itself.
  try {
    const folders = await findFoldersByCode(from)
    if (folders.length) {
      res.blockers.push(`พบโฟลเดอร์ใน Drive ชื่อนำด้วยรหัส ${from} (${folders.length}: ${folders.slice(0, 3).map(f => f.name).join(' | ')}) — ต้องเปลี่ยนชื่อโฟลเดอร์ตามด้วย (ยังไม่รองรับ) ทำมือก่อน`)
    }
  } catch (e: any) {
    res.blockers.push(`ตรวจโฟลเดอร์ใน Drive ไม่ได้ (${e?.message || e}) — ไม่รู้ว่ามีโฟลเดอร์ที่ชื่อตามรหัสเดิมไหม จึงไม่แก้`)
  }
  if (res.blockers.length) return { ...res, ok: false }

  const ids = fromRows.map(r => r.id)
  const bookingIds = Array.from(new Set(fromRows.map(r => r.bookingId)))
  const bookings = (await prisma.booking.findMany({ where: { id: { in: bookingIds } }, include: bookingInclude }))
    .sort((a, b) => String(a.bookingCode).localeCompare(String(b.bookingCode)))
  const renamed = (b: (typeof bookings)[number]) => ({ ...b, episodes: b.episodes.map(e => (e.episodeId === from ? { ...e, episodeId: to } : e)) })
  const joinWithRename = (b: (typeof bookings)[number]) => renamed(b).episodes.map(e => e.episodeId).join(', ')

  res.bookings = bookings.map(b => ({ bookingCode: b.bookingCode, status: b.status, deleted: !!b.deletedAt, sheetEpisodeIds: joinWithRename(b) }))
  res.notes = [...NOTES]
  if (dryRun) return res

  // (1) sheet FIRST — repeatable, and the surface PMDC joins on (it reads CANCELLED rows too, so soft-deleted
  // bookings are written as well). A real error aborts before the DB commit.
  for (const b of bookings) {
    if (!b.bookingCode) { res.effects.push({ bookingCode: null, sheet: 'skipped', marker: 'n/a' }); continue }
    const sheet = await updateBookingRow(b.bookingCode, { episodeIds: joinWithRename(b) })
    res.effects.push({ bookingCode: b.bookingCode, sheet, marker: 'n/a' })
    if (sheet === 'error') {
      return { ...res, ok: false, error: `เขียนชีทของ ${b.bookingCode} ไม่สำเร็จ — DB ยังไม่ถูกแตะ รันซ้ำได้ (ใบก่อนหน้าที่เขียนชีทไปแล้วจะถูกเขียนค่าเดิมซ้ำ ไม่เสียหาย)` }
    }
    if (sheet === 'not-found') res.warnings.push(`${b.bookingCode}: ไม่พบแถวในชีท Bookings — PMDC จะยังไม่เห็นรหัสใหม่ของใบนี้`)
    if (sheet === 'skipped') res.warnings.push(`${b.bookingCode}: ข้ามการเขียนชีท (ไม่มี credential)`)
  }

  // (2) `_SHOOT.txt` — the contract the PMC footage crawler reads (Production ID + Episode IDs). Nothing else
  // ever rewrites its episode list (the nightly reconciler audits only the Production ID and the date), so it
  // goes before the commit like the sheet: an upsert of the same content, safe to repeat; a failure aborts.
  for (const b of bookings) {
    if (b.deletedAt || !b.bookingCode) continue
    const eff = res.effects.find(x => x.bookingCode === b.bookingCode)!
    try {
      eff.marker = await refreshShootMarker(renamed(b))
    } catch (e: any) {
      return { ...res, ok: false, error: `เขียน _SHOOT.txt ของ ${b.bookingCode} ไม่สำเร็จ (${e?.message || e}) — DB ยังไม่ถูกแตะ รันซ้ำได้` }
    }
  }

  // (3) DB, one transaction, plan re-checked inside it, audit rows committed WITH the rename
  try {
    await prisma.$transaction(async tx => {
      const still = await tx.episode.count({ where: { id: { in: ids }, episodeId: from, uploads: { none: {} } } })
      if (still !== ids.length) throw new Error('EPISODE_CHANGED')
      if ((await tx.episode.count({ where: { episodeId: to, bookingId: { in: bookingIds } } })) !== 0) throw new Error('TARGET_EXISTS')
      // uploads re-asserted on the write itself: a file linked between the count and this statement must not slip through
      const moved = await tx.episode.updateMany({ where: { id: { in: ids }, episodeId: from, uploads: { none: {} } }, data: { episodeId: to } })
      if (moved.count !== ids.length) throw new Error('EPISODE_CHANGED')
      // mix jobs keep a readable snapshot of the code (v1.244) — same episode, same code
      await tx.mixJob.updateMany({ where: { episodeRowId: { in: ids } }, data: { episodeCode: to } })
      await tx.auditLog.createMany({
        data: bookings.map(b => ({
          actorEmail: actor, action: 'booking.episode_renamed', entityType: 'Booking', entityId: b.id,
          bookingCode: b.bookingCode, changes: { from, to, deletedBooking: !!b.deletedAt },
        })),
      })
    })
  } catch (e: any) {
    const why = e?.message === 'EPISODE_CHANGED' ? 'ตอนเปลี่ยนไประหว่างรัน (อาจมีไฟล์เพิ่งอัปโหลดเข้ามา)'
      : e?.message === 'TARGET_EXISTS' ? `ใบเดียวกันเพิ่งได้รหัส ${to} ระหว่างรัน`
        : `DB ล้ม: ${e?.message || e}`
    console.error(`[episode-sync] ${from} → ${to} NOT committed: ${e?.message || e}`)
    return { ...res, ok: false, error: `${why} — ไม่ได้เปลี่ยนรหัสใน DB · ชีท/_SHOOT.txt ของบางใบอาจเป็นรหัสใหม่ไปแล้ว: รันซ้ำเมื่อพร้อม หรือสั่งคืนค่าเดิม` }
  }
  res.committed = true
  console.info(`[episode-sync] ${from} → ${to} committed by ${actor}: ${bookings.map(b => b.bookingCode).join(', ')}`)
  return res
}

// ── 3. drift report + automatic path ──────────────────────────────────────────

type Loaded = { ok: true; dash: DashEp[]; rows: EpRow[]; drift: Drift[] } | { ok: false; error: string }

/** Reads the Dashboard + the DB. Read-only. A failed, empty or sandbox Dashboard read is an error, never "no drift". */
async function loadDrift(): Promise<Loaded> {
  if (isUsingSandboxSheet()) return { ok: false, error: 'แอปกำลังชี้ Producer Dashboard ชีททดสอบ (PRODUCER_DASHBOARD_SHEET_ID) — รายงานเทียบกับชีทผิดตัว จึงไม่รายงาน' }
  const dash = await listAllDashboardEpisodes()
  if (!dash.ok) return { ok: false, error: `อ่าน Dashboard ไม่ได้: ${dash.error}` }
  if (dash.episodes.length === 0) return { ok: false, error: 'Dashboard ไม่มีตอนเลย — ไม่ตัดสินจากความว่างเปล่า (โครงชีทเปลี่ยน?)' }
  const de = dash.episodes.map(e => ({ episodeId: e.episodeId, label: dashLabel(e), ownLabel: hasOwnLabel(e), previousIds: e.previousIds }))
  const rows = await loadRows({ episodeId: { startsWith: 'PP-' } })
  return { ok: true, dash: de, rows, drift: planDrift(rows, de) }
}

export type DriftReport =
  | { ok: true; dashboardEpisodes: number; bookingRows: number; drift: Drift[] }
  | { ok: false; error: string }

export async function driftReport(): Promise<DriftReport> {
  const l = await loadDrift()
  return l.ok ? { ok: true, dashboardEpisodes: l.dash.length, bookingRows: l.rows.length, drift: l.drift } : l
}

export type AutoResult = {
  /** false when the Dashboard could not be read, a tripwire fired, or ANY rename failed or was refused */
  ok: boolean
  error?: string
  autoApplyEnabled?: boolean
  applied?: boolean
  failed?: number
  /** set when a write was asked for but the switch is off — a preview must never read like a write */
  note?: string
  drift?: Drift[]
  results?: RenameResult[]
}

const autoInflight = new Map<string, { p: Promise<AutoResult>; at: number }>()

/**
 * Apply every rename-candidate. Real writes need EPISODE_SYNC_AUTOAPPLY=1 on the stack (default OFF —
 * staged like footage-ready: read a few clean reports first); with it off this is a dry run and says so.
 * Tripwires (more candidates than MAX_AUTO_RENAMES or more orphans than MAX_ORPHANS_FOR_AUTO in one run)
 * refuse the whole run: that is a bad read or a bulk edit, not drift. Every candidate goes through the same
 * dry run first; refused ones are reported (and make `ok` false) and never attempted for real.
 * A concurrent call with the same `apply` joins the run in flight.
 */
export function autoApplyDrift(o: { apply: boolean; actor: string }): Promise<AutoResult> {
  const key = String(o.apply)
  const running = autoInflight.get(key)
  if (running && Date.now() - running.at < INFLIGHT_TTL_MS) return running.p
  const p = doAuto(o).finally(() => { if (autoInflight.get(key)?.p === p) autoInflight.delete(key) })
  autoInflight.set(key, { p, at: Date.now() })
  return p
}

async function doAuto(o: { apply: boolean; actor: string }): Promise<AutoResult> {
  const l = await loadDrift()
  if (!l.ok) return l
  const dashCodes = new Set(l.dash.map(d => d.episodeId))
  const candidates = l.drift.filter(d => d.kind === 'rename-candidate' && d.candidate)
  const orphans = l.drift.reduce((n, d) => n + d.orphans.length, 0)
  if (candidates.length > MAX_AUTO_RENAMES || orphans > MAX_ORPHANS_FOR_AUTO) {
    return {
      ok: false, drift: l.drift,
      error: `รอบนี้มี ${candidates.length} คู่ที่จับคู่ได้ / ${orphans} รหัสที่ Dashboard ไม่มี (เพดาน ${MAX_AUTO_RENAMES} / ${MAX_ORPHANS_FOR_AUTO}) — ไม่ใช่ drift ปกติ (อ่าน Dashboard ไม่ครบ? แก้ทีละมาก?) ไม่แก้อัตโนมัติ: ดูรายงานแล้วสั่งทีละคู่`,
    }
  }
  const enabled = process.env.EPISODE_SYNC_AUTOAPPLY === '1'
  const applied = o.apply && enabled

  const results: RenameResult[] = []
  for (const c of candidates) {
    const pair = c.candidate!
    const dry = await renameEpisodeCode({ ...pair, actor: o.actor, dryRun: true, dashboardCodes: dashCodes })
    if (!applied || !dry.ok || dry.nothingToDo) { results.push(dry); continue }   // preview, refused, or already done
    try {
      results.push(await renameEpisodeCode({ ...pair, actor: o.actor, dryRun: false, dashboardCodes: dashCodes }))
    } catch (e: any) {
      console.error(`[episode-sync] auto ${pair.from} → ${pair.to} threw:`, e)
      results.push(failed({ ...pair, dryRun: false }, `เกิดข้อผิดพลาดระหว่างแก้: ${e?.message || e}`))
    }
  }
  const nFailed = results.filter(r => !r.ok).length
  return {
    ok: nFailed === 0, autoApplyEnabled: enabled, applied, failed: nFailed, drift: l.drift, results,
    ...(o.apply && !enabled ? { note: 'ขอให้แก้จริง แต่ EPISODE_SYNC_AUTOAPPLY ยังปิดอยู่ — ผลนี้เป็น dry-run ไม่มีอะไรถูกเขียน' } : {}),
  }
}
