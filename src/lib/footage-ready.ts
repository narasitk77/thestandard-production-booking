/**
 * Auto "footage ready" notification (v1.147) — the automated counterpart of the
 * manual 📣 notify-ready button. A supervised worker sweeps recent bookings and,
 * once a booking's footage looks COMPLETE AND SETTLED, emails the folder links
 * automatically (audience configurable) — exactly once per booking.
 *
 * "Ready" = ALL of:
 *   a) eligible      — CONFIRMED/COMPLETED, not deleted, no cancel request,
 *                      has a bookingCode, not a photo-album booking
 *   b) shoot over    — isShootOver() (Bangkok time, honors shootEndDate)
 *   c) no in-flight  — zero PENDING/UPLOADING Upload rows fresher than 24h
 *                      (older = abandoned browser tab, must not block forever)
 *   d) NAS drained   — the NAS queue for this code is absent or lastPending=0
 *   e) footage exists— fresh Drive walk (sweepFootagePayload — dryRun too)
 *                      sees >0 folders and >0 files. The Drive walk is the ONLY
 *                      signal that covers BOTH delivery paths (browser uploads
 *                      AND NAS→video-merge, which creates no Upload rows)
 *   f) settled       — fileCount+totalBytes unchanged for FOOTAGE_READY_SETTLE_MS
 *                      (default 2 h — covers the "dump card 1 → travel/dinner →
 *                      dump card 2" gap) across sweeps, so a multi-batch card
 *                      dump doesn't fire after the first batch
 *   g) MEDIAPRO      — v1.254: every file each Sony card's MEDIAPRO.XML lists is in
 *                      the box (none 0 bytes, none far smaller per frame than its
 *                      siblings), and no Sony card is missing its MEDIAPRO. A copy
 *                      that died when the NAS lost the computer settles just like a
 *                      finished one — (f) alone announced AGN-260929-01 with two
 *                      144 GB originals still on the NAS. Not bypassed by forced codes.
 *
 * Send-once: Booking.readyNotifiedAt (stamped here AND by the manual notify-ready
 * route, so a manual 📣 suppresses the auto email). deliveredAt-null is also
 * required — if crew already pressed ส่งงาน the producer has the report.
 * Settle state persists in Booking.readySnapshot so restarts lose nothing.
 *
 * Rollout guard: only bookings whose shoot ended within FOOTAGE_READY_LOOKBACK_DAYS
 * (default 3) are ever considered — the first production run cannot blast the
 * backlog. The worker itself is OFF until FOOTAGE_READY_WORKER_ENABLED=1.
 */
import { prisma } from './db'
import { logAudit } from './audit'
import { sendEmail, isEmailConfigured } from './email'
import { notifyChatDetailed, notifyEmailDigest } from './notify'
import { getCachedFootagePayload, computeFootagePayload, type FootagePayload, type BookingForFootagePayload } from './footage-folders'
import { isPhotoAlbumBooking } from './outlet-folders'
import { isShootOver } from './shoot-window'
import { latestNasState, nasManifestAge } from './nas-sync'
import { PHOTO_ALBUM_EPISODE_CODE } from './outlet-folders'
import { formatBytes } from './footage-report'
import { bookingDisplayName } from './display'
import { ADMIN_DIGEST, readHeld } from './footage-ready-health'
import { mediaproGate } from './mediapro'
import { folderLiveness, findFoldersByCode } from './google-drive'
import { isQuarantined, sonyClipPart, type FootageFileLike } from './footage-completeness'

const DAY = 86_400_000

// ── Camera coverage (v1.267) ────────────────────────────────────────────────
// ตรวจระบบ 11 ต.ค. 2569: AGN-261007-01 กับ POD-OPR-261007-01 ถูกแจ้ง "พร้อม" ตอนกล่องมีแต่ไฟล์เสียง (เมลเขียนเองว่า
// "ไม่มีการ์ด Sony") และ TSS-TSS-261009-01 ถูกแจ้งตอน CAM-C ยังไม่มีไฟล์ภาพเลย (มาถึงอีก 13 ชม.) — ด่าน MEDIAPRO
// มองไม่เห็นกล้องที่ยังไม่มีอะไรบน Drive และด่าน NAS ปิดเมื่อตัวสแกนเงียบ จึงไม่มีอะไรกัน
const VIDEO_EXT = /\.(mxf|mp4|mov|braw|r3d|crm|mts|m2ts|avi|mkv|insv)$/i
// "CAM-A", "CAM B", "CAM1", "CAM A-1" (card A-1 of camera A), "CAM-C (1)" (sync-storm twin of CAM-C)
const CAM_DIR = /^CAM[\s._-]*([A-Z]|\d{1,2})(?:[\s._-]*\d{1,2})?$/i
// extra cameras / other media that are not one of the booked CAM slots — video here neither counts nor blinds the count
const EXTRA_DIR = /^(DRONE|ACTION[\s._-]*CAM|GOPRO|INSTA\d*|DCIM|AUDIO|SOUND|PHOTO|BTS)\b/i
const stripDup = (s: string) => s.trim().replace(/(?:\s*\(\d+\))+$/, '')

/**
 * วันสุดท้ายที่ยังรอกล้องได้ — คิดจากหน้าต่างแจ้งอัตโนมัติจริง (review v1.267: ค่าคงที่ 48 ชม. ทำให้เตือนก่อนกล้องชุดสุดท้าย
 * มาไม่กี่ชั่วโมง และถ้า LOOKBACK=3 ตามค่าตั้งต้น การรอจะจบพร้อมหน้าต่างพอดี = หลุดเงียบ): shootDate เป็น @db.Date (00:00Z)
 * และหน้าต่างคือ shootDate ≥ now−lookback → รอได้ถึง วันถ่ายวันสุดท้าย + lookback − settle − 1 ชม. แล้วยังเหลือรอบส่งก่อนหน้าต่างปิด
 */
export function cameraWaitUntil(shootEnd: Date, lookbackDays: number, settleMs: number): number {
  return new Date(shootEnd).getTime() + lookbackDays * DAY - settleMs - 3_600_000
}

export interface CameraCoverage {
  /** video originals found (Sony proxies `…S03.MP4` are not originals) */
  video: number
  /** camera folders (CAM-A, CAM B, …) holding at least one video original */
  cams: string[]
  /** some video sits outside any CAM-x folder → cameras cannot be counted (only "no video at all" is judged) */
  uncounted: boolean
  /** empty = complete; otherwise one Thai line saying what is short */
  gap: string
}

export function cameraCoverage(
  files: FootageFileLike[],
  b: { cameraCount?: number | null; crewRequired?: string[] | null },
  /** folders that are byte-identical copies of another card (MEDIAPRO twinCopies) — a copy is not a second camera */
  copyDirs: string[] = [],
): CameraCoverage {
  const cams = new Set<string>()
  let video = 0
  let uncounted = false
  const copies = copyDirs.map(d => d.toUpperCase())
  for (const f of files) {
    if (isQuarantined(f) || !VIDEO_EXT.test(f.name) || sonyClipPart(f.name)?.part === 'sub') continue
    video++
    const path = f.folderPath || []
    const joined = path.join('/').toUpperCase()
    if (copies.some(d => joined === d || joined.startsWith(d + '/'))) continue
    const cam = path.map(s => CAM_DIR.exec(stripDup(s))).find(Boolean)
    if (cam) cams.add(`CAM-${cam[1].toUpperCase()}`)
    else if (!path.some(s => EXTRA_DIR.test(s.trim()))) uncounted = true
  }
  const expected = b.cameraCount || 0
  const expectVideo = expected > 0 || (b.crewRequired || []).some(r => /video|camera|กล้อง|ช่างภาพ/i.test(r))
  const list = [...cams].sort()
  let gap = ''
  if (expectVideo && video === 0) gap = 'ยังไม่มีไฟล์ภาพจากกล้องเลย (มีแต่ไฟล์อื่น เช่น เสียง)'
  else if (!uncounted && expected > 0 && cams.size < expected) gap = `มีไฟล์ภาพ ${cams.size}/${expected} กล้อง (${list.join(', ') || '—'})`
  return { video, cams: list, uncounted, gap }
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type FootageReadyAudience = 'producer' | 'team' | 'everyone' | 'admin'

export function footageReadyAudience(): FootageReadyAudience {
  const v = (process.env.FOOTAGE_READY_AUDIENCE || '').trim().toLowerCase()
  return v === 'everyone' || v === 'admin' || v === 'team' ? v : 'producer'
}

/** Domains that count as "our staff" for the `team` audience. */
export function footageReadyInternalDomains(): string[] {
  const raw = process.env.FOOTAGE_READY_INTERNAL_DOMAINS?.trim()
  if (!raw) return ['thestandard.co']
  const list = raw.split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  return list.length > 0 ? list : ['thestandard.co']
}

/**
 * v1.179 — `team` = staff only. Same list as `everyone` minus anyone outside our
 * domains, because assignedEmails carries freelancers' PERSONAL addresses and the
 * operator did not want a one-day freelancer mailed a Drive link for every shoot
 * they ever touched. Shared boxes (video@, sound@) stay IN — unlike the review
 * invites, where a shared inbox was a credential problem, here it is simply how
 * "the camera team" is reached.
 *
 * Exactly one '@' required. Splitting on the LAST one would read
 * `a@b@thestandard.co` as internal — same trap already paid for in
 * isInvitableEmail (v1.173.1).
 */
export function isInternalEmail(email: string, domains: string[] = footageReadyInternalDomains()): boolean {
  const parts = (email || '').trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  return domains.includes(parts[1])
}

/**
 * Who gets the "footage พร้อม" mail for one booking.
 *
 * v1.178 — the operator's instruction was "ไม่ควรส่งให้ผมคนเดียว ควรส่งให้ทีมงานด้วย":
 * the team is to be ADDED, not swapped in. Before this, moving the audience off
 * 'admin' silently REMOVED his copy — the producer/everyone branch never touched
 * the digest — so the config change that answers the complaint would also have
 * hidden the feature from the one person who watches it.
 *
 *   people — one mail EACH (assignedEmails can carry a freelancer's personal
 *            address, so the caller must never put them in a shared To:)
 *   digest — send the admin digest as well; suppressed when the admin is already
 *            a named recipient so nobody is mailed the same thing twice
 *
 * v1.264 — Co-Producer เข้ารายชื่อด้วย (นัท 11 ต.ค. 2569 "เพิ่ม Co-Producer เข้ารายชื่อแจ้งฟุตเทจพร้อมด้วย"):
 * TSS มี phoemsiri.p@ เป็น Co-Producer 32/52 ใบ แต่ได้แจ้งแค่ใบที่ตัวเองเป็นคนสร้าง (11 ใบ) · ปุ่ม 📣 แจ้งมือ
 * (notify-ready route) ใช้ฟังก์ชันนี้ด้วย — กฎ "ใครได้แจ้ง" อยู่ที่เดียว
 * v1.267 — ผู้กำกับ 1–3 (AGN) ด้วย: ตรวจระบบ 11 ต.ค. พบ worased.p@/tanapak.i@/panyapohn.s@ พลาด 12 ฉบับ (audience team/everyone)
 *
 * v1.264 — คนที่ปิดบัญชีแล้ว (users.active=false) ไม่ได้เมล และถูกคืนใน `inactive` ให้ผู้เรียกบันทึก (ไม่ตัดเงียบ):
 * แก้ว (phoemsiri.p@) ออก 28 ก.ย. แต่ยังเป็นคนสร้างใบ → 9 ต.ค. เมลเด้ง 550 5.1.1 ขณะที่ audit นับว่าส่งถึง
 * (SMTP รับไว้ก่อนแล้วค่อยตีกลับ) — กฎเดียวกับ QU reminder v1.243
 */
export function footageReadyRecipients(
  audience: FootageReadyAudience,
  b: {
    producerEmail?: string | null; coProducerEmail?: string | null; createdByEmail?: string | null; assignedEmails?: string[] | null
    directorEmail?: string | null; director2Email?: string | null; director3Email?: string | null
  },
  adminEmail?: string | null,
  inactiveEmails: Iterable<string> = [],
): { people: string[]; digest: boolean; inactive: string[] } {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  const admin = clean(adminEmail)
  if (audience === 'admin') return { people: [], digest: true, inactive: [] }

  const raw =
    audience === 'everyone' || audience === 'team'
      ? [b.producerEmail, b.coProducerEmail, b.directorEmail, b.director2Email, b.director3Email, b.createdByEmail, ...(b.assignedEmails || [])]
      : [b.producerEmail, b.coProducerEmail]
  let people = Array.from(new Set(raw.map(clean).filter(e => e.includes('@'))))
  if (audience === 'team') people = people.filter(e => isInternalEmail(e))
  const gone = new Set(Array.from(inactiveEmails, clean))
  const inactive = people.filter(e => gone.has(e))
  people = people.filter(e => !gone.has(e))
  return { people, digest: !!admin && !people.includes(admin), inactive }
}

/** อีเมลของผู้ใช้ที่ปิดบัญชีแล้ว — ใส่เป็นอาร์กิวเมนต์ที่ 4 ของ footageReadyRecipients */
export async function inactiveUserEmails(): Promise<string[]> {
  return (await prisma.user.findMany({ where: { active: false }, select: { email: true } })).map(u => u.email)
}

// ── Pure settle logic (unit-tested) ────────────────────────────────────────

export type ReadySnapshot = { fileCount: number; totalBytes: number; at: string }

/** Coerce the Booking.readySnapshot JSON blob; malformed → null (restart timer). */
export function parseReadySnapshot(json: unknown): ReadySnapshot | null {
  const s = json as Partial<ReadySnapshot> | null | undefined
  if (!s || typeof s !== 'object') return null
  if (typeof s.fileCount !== 'number' || typeof s.totalBytes !== 'number' || typeof s.at !== 'string') return null
  if (!Number.isFinite(new Date(s.at).getTime())) return null
  return { fileCount: s.fileCount, totalBytes: s.totalBytes, at: s.at }
}

/**
 * Gate (f): the footage counts must be IDENTICAL to a snapshot taken at least
 * `settleMs` ago. Counts changed (or first sighting) → restart the timer by
 * writing a fresh snapshot (`write`); unchanged but young → keep waiting with
 * the existing snapshot (write:null, no DB touch).
 */
export function evaluateSettle(
  current: { fileCount: number; totalBytes: number },
  snapshot: ReadySnapshot | null,
  now: Date,
  settleMs: number,
): { settled: boolean; write: ReadySnapshot | null } {
  if (snapshot && snapshot.fileCount === current.fileCount && snapshot.totalBytes === current.totalBytes) {
    const age = now.getTime() - new Date(snapshot.at).getTime()
    return { settled: age >= settleMs, write: null }
  }
  return { settled: false, write: { fileCount: current.fileCount, totalBytes: current.totalBytes, at: now.toISOString() } }
}

/**
 * v1.179 — the order the capped Drive walks are handed out in.
 *
 * The bug this closes: `findMany` had no `orderBy` at all, so Postgres returned
 * the same rows in the same order every sweep and `slice(0, MAX_PER_RUN)` handed
 * the budget to the same five bookings forever. Proven against prod — three
 * consecutive dry runs walked an identical five and deferred an identical four.
 * Worse, the five squatters were bookings that can never have footage (THE
 * STANDARD NOW ×2, an event, a lighting-only job): they are never notified, so
 * they are never stamped, so they held the queue for the whole lookback window
 * and the shoots behind them were never walked ONCE — not "notified late",
 * never notified at all, because they aged out of the window still unwalked.
 *
 * least-recently-walked first, never-walked at the very front (a booking that
 * just became eligible jumps the queue, which is what people are waiting for),
 * newest shoot as the tie-break.
 */
export function orderForWalk<T extends { readyCheckedAt?: Date | null; shootDate: Date | string }>(rows: T[]): T[] {
  const checked = (r: T) => (r.readyCheckedAt ? new Date(r.readyCheckedAt).getTime() : -1)
  const shot = (r: T) => new Date(r.shootDate).getTime()
  return [...rows].sort((a, b) => checked(a) - checked(b) || shot(b) - shot(a))
}

/** Most codes one forced call may carry — a fat finger must not become a blast. */
export const FORCED_MAX = 25

/**
 * v1.182 — `?codes=` turns the sweep into the headless equivalent of a human
 * pressing 📣 on one booking.
 *
 * Why it has to exist: the sweep only ever looks at shoots inside
 * FOOTAGE_READY_LOOKBACK_DAYS, so a booking whose footage landed late falls out
 * of the window and the auto path is done with it FOREVER (see the aged-out
 * bucket in footage-ready-health). The advice "press 📣 by hand" assumed a
 * logged-in browser; the operator asking for it from a chat has none.
 *
 * Malformed input must narrow the set, never widen it: an empty/garbage param
 * yields [] and the caller falls back to a normal windowed sweep — it must never
 * be read as "every booking".
 */
export function parseForcedCodes(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const code = part.trim().toUpperCase()
    if (/^[A-Z0-9-]{4,40}$/.test(code)) seen.add(code)
    if (seen.size >= FORCED_MAX) break
  }
  return Array.from(seen)
}

// ── Scan ────────────────────────────────────────────────────────────────────

export type FootageReadyScanResult = {
  dryRun: boolean
  forced: string[]           // codes named by the caller; [] = normal windowed sweep
  audience: FootageReadyAudience
  scanned: number            // candidates from the DB window
  eligible: number           // survivors of the JS gates (shoot over, no in-flight, NAS drained)
  walked: number             // Drive walks actually performed this sweep
  deferred: number           // eligible but beyond MAX_PER_RUN — picked up next sweep
  deferredCodes: string[]    // v1.179 — WHICH ones. A bare count sent us back to
                             // the calendar to guess who was starved; never again.
  notified: string[]         // booking codes notified this sweep
  settling: string[]         // codes waiting out the settle window
  skipped: Array<{ code: string; reason: string; detail?: string }>
  errors: Array<{ code: string; error: string }>
  /** v1.268 — bookings sent with a camera warning whose missing cameras have now arrived: second notice sent (dry run: would send) */
  followedUp: string[]
  /** v1.268 — still waiting for the second notice, with why */
  followUpWaiting: Array<{ code: string; detail: string }>
}

// `program` is widened here (the base type has name only) so the photo-album
// gate can read the BOOKING's program code, not just each episode's.
type CandidateRow = Omit<BookingForFootagePayload, 'program'> & {
  program: { name: string; code?: string | null }
  id: string
  bookingCode: string | null
  status: string
  shootDate: Date
  shootEndDate: Date | null
  estimatedWrap: string | null
  callTime: string
  readySnapshot: unknown
  producer: string
  producerEmail: string | null
  coProducerEmail: string | null
  cameraCount: number | null
  crewRequired: string[]
  directorEmail: string | null
  director2Email: string | null
  director3Email: string | null
  createdByEmail: string | null
  assignedEmails: string[]
  outlet: { code: string; name: string }
  episodes: Array<{ episodeId: string | null; sequence: number; title: string | null; program: { name: string; code: string } | null }>
}

/**
 * Gate (e)'s Drive walk. Both paths walk fresh: the system-wide video-merge worker
 * moves files WITHOUT clearing footageCache, so the cache can be stale-empty.
 *
 * v1.265 — dryRun used to read the cache only (its "refresh if empty" fallback
 * called the same cache read twice), so the preview said `no-footage` for
 * KND-KNF-260916-01 — 152 GB in the box — while the real run, which refreshes,
 * mailed it (2026-10-11). A preview that disagrees with the run is worse than
 * none. computeFootagePayload persists nothing, so dryRun stays write-free.
 */
const CANDIDATE_SELECT = {
  id: true, bookingCode: true, status: true, driveFolders: true,
  projectId: true, projectName: true, category: true, crewRequired: true,
  producer: true, producerEmail: true, coProducerEmail: true, createdByEmail: true, assignedEmails: true,
  directorEmail: true, director2Email: true, director3Email: true, cameraCount: true,
  callTime: true, shootDate: true, shootEndDate: true, estimatedWrap: true,
  readySnapshot: true, readyCheckedAt: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true, code: true } },
  episodes: {
    orderBy: { sequence: 'asc' as const },
    select: { episodeId: true, sequence: true, title: true, program: { select: { name: true, code: true } } },
  },
}

export async function sweepFootagePayload(b: BookingForFootagePayload, dryRun: boolean): Promise<FootagePayload> {
  return dryRun ? computeFootagePayload(b) : getCachedFootagePayload(b, { refresh: true })
}

/** v1.274 — `readySnapshot.held` (see readHeld). Written only when the reason or the footage changed. */
async function noteHeld(b: { id: string; readySnapshot: unknown }, code: string, detail: string, fileCount: number, totalBytes: number, now: Date): Promise<void> {
  const prev = readHeld(b.readySnapshot)
  if (prev && prev.detail === detail && prev.fileCount === fileCount && prev.totalBytes === totalBytes) return
  const base = b.readySnapshot && typeof b.readySnapshot === 'object' ? (b.readySnapshot as Record<string, unknown>) : {}
  await prisma.booking.update({
    where: { id: b.id },
    data: { readySnapshot: { ...base, held: { detail, fileCount, totalBytes, at: now.toISOString() } } as any },
  }).catch(e => console.error('[footage-ready] noteHeld failed:', code, e?.message || e))
}

export async function runFootageReadyScan(
  opts: { dryRun?: boolean; codes?: string[] } = {},
): Promise<FootageReadyScanResult> {
  const result = await runReadySweep(opts)
  // a caller naming codes asks about THOSE bookings — follow-ups belong to the unattended sweep
  if (result.forced.length === 0) await followUpCameraGaps(result)
  return result
}

async function runReadySweep(
  opts: { dryRun?: boolean; codes?: string[] },
): Promise<FootageReadyScanResult> {
  const dryRun = !!opts.dryRun
  const forced = (opts.codes || []).slice(0, FORCED_MAX)
  const now = new Date()
  const audience = footageReadyAudience()
  const lookbackDays = envInt('FOOTAGE_READY_LOOKBACK_DAYS', 3)
  const settleMs = envInt('FOOTAGE_READY_SETTLE_MS', 2 * 60 * 60_000)
  const maxPerRun = envInt('FOOTAGE_READY_MAX_PER_RUN', 5)
  const since = new Date(now.getTime() - lookbackDays * DAY)

  const result: FootageReadyScanResult = {
    dryRun, forced, audience, scanned: 0, eligible: 0, walked: 0, deferred: 0, deferredCodes: [],
    notified: [], settling: [], skipped: [], errors: [], followedUp: [], followUpWaiting: [],
  }
  let inactive: string[] | undefined // v1.264 — users.active=false, read once per scan and only when a notice goes out

  const rows = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      deletedAt: null,
      cancelRequestedAt: null,
      readyNotifiedAt: null,
      deliveredAt: null, // crew already ส่งงาน → producer already has the report
      // Named codes swap out the DATE window only. Send-once, deleted, cancelled
      // and ส่งงาน still apply: "force" means "look past the window", not "ignore
      // every rule" — re-sending a booking already notified stays a deliberate
      // readyNotifiedAt clear, not a flag. (`in` also covers `not: null`.)
      ...(forced.length > 0
        ? { bookingCode: { in: forced } }
        : {
            bookingCode: { not: null },
            OR: [{ shootDate: { gte: since } }, { shootEndDate: { gte: since } }],
          }),
    },
    select: CANDIDATE_SELECT,
  }) as unknown as CandidateRow[]
  result.scanned = rows.length
  if (rows.length === 0) return result

  // Gate (c): one groupBy covers every candidate — a PENDING/UPLOADING Upload
  // row fresher than 24h means the crew is still actively uploading.
  const freshInFlight = await prisma.upload.groupBy({
    by: ['bookingId'],
    where: {
      bookingId: { in: rows.map(r => r.id) },
      status: { in: ['PENDING', 'UPLOADING'] },
      updatedAt: { gte: new Date(now.getTime() - DAY) },
    },
    _count: true,
  })
  const uploading = new Set(freshInFlight.map(u => u.bookingId))

  // Gate (d): NAS queue state, one read for the whole sweep.
  // v1.262.1 — only while the NAS picture is fresh: a dead Mac agent leaves its last "still sending"
  // forever, which held a booking's notice silently (review of v1.262). Stale = gate off; the operator
  // hears about the silent scanner from the relay instead.
  const nasState = await latestNasState().catch(() => ({ manifest: null, statuses: {} as Record<string, any> }))
  const nasStatuses = nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale ? (nasState.statuses || {}) : {}

  const eligible: CandidateRow[] = []
  for (const b of rows) {
    const code = b.bookingCode as string
    if (!isShootOver({ shootDate: b.shootDate, shootEndDate: b.shootEndDate, estimatedWrap: b.estimatedWrap }, now)) {
      result.skipped.push({ code, reason: 'shoot-not-over' }); continue
    }
    // v1.179 — also honour the BOOKING's own program. isPhotoAlbumBooking reads
    // the EPISODES' program code, and WLT-OTH-260819-01 (a Photo Album booking,
    // lighting only) slipped through it every sweep because its episode code is
    // 'OTH' — burning a walk slot on a job that by definition has no video.
    // A caller who names the code has already decided this job has footage worth
    // sending; only the unattended sweep needs the category guess.
    if (forced.length === 0 &&
        (isPhotoAlbumBooking(b.episodes) || (b.program?.code || '').toUpperCase() === PHOTO_ALBUM_EPISODE_CODE)) {
      result.skipped.push({ code, reason: 'photo-album' }); continue
    }
    if (uploading.has(b.id)) {
      result.skipped.push({ code, reason: 'uploads-in-flight' }); continue
    }
    const nas = nasStatuses[code]
    if (nas && (nas.lastPending || 0) > 0) {
      result.skipped.push({ code, reason: 'nas-still-sending' }); continue
    }
    eligible.push(b)
  }
  result.eligible = eligible.length

  // Cap the expensive Drive walks per sweep; the rest are picked up next run —
  // which only holds because orderForWalk rotates the queue (see its comment).
  const ordered = orderForWalk(eligible)
  // An explicit request is not subject to the sweep's politeness budget — the
  // caller named at most FORCED_MAX codes and is waiting for all of them.
  const toWalk = forced.length > 0 ? ordered : ordered.slice(0, maxPerRun)
  result.deferred = ordered.length - toWalk.length
  result.deferredCodes = ordered.slice(maxPerRun).map(r => r.bookingCode as string)

  for (const b of toWalk) {
    const code = b.bookingCode as string
    try {
      const payload = await sweepFootagePayload(b, dryRun)
      result.walked++
      // Stamp BEFORE the outcome branches: a walk that found nothing still has to
      // move this booking to the back of the queue, or it squats forever (that is
      // exactly the bug — see orderForWalk).
      if (!dryRun) {
        await prisma.booking.update({ where: { id: b.id }, data: { readyCheckedAt: now } }).catch(() => {})
      }
      if (payload.folders.length === 0 || payload.fileCount === 0) {
        result.skipped.push({ code, reason: 'no-footage' })
        continue
      }
      // Forced = a human decided it is ready now, so the 4h stability window is
      // not theirs to wait out. The "footage actually exists" check above is NOT
      // bypassed — an email of empty folders is worse than no email.
      const decision = forced.length > 0 ? { settled: true, write: null } : evaluateSettle(
        { fileCount: payload.fileCount, totalBytes: payload.folders.reduce((n, f) => n + f.totalBytes, 0) },
        parseReadySnapshot(b.readySnapshot),
        now,
        settleMs,
      )
      if (!decision.settled) {
        result.settling.push(code)
        if (!dryRun && decision.write) {
          await prisma.booking.update({ where: { id: b.id }, data: { readySnapshot: decision.write } }).catch(() => {})
        }
        continue
      }

      // Gate (g) — every file the cards' MEDIAPRO.XML lists must be in place. Checks the
      // same places the email announces: the LIVE box plus every folder named with this
      // code (a drop folder still holding a half-copied card counts). Runs in dry-run too
      // (read-only), so a preview says exactly what the sweep would do.
      const box = (b.driveFolders as Record<string, unknown> | null)?.box
      const boxState = typeof box === 'string' ? await folderLiveness(box) : 'dead'
      if (boxState === 'unknown') {
        result.skipped.push({ code, reason: 'mediapro-incomplete', detail: 'ตรวจกล่องไม่ได้ (Drive) — รอรอบหน้า' })
        continue
      }
      const roots = [...new Set([...(boxState === 'alive' ? [box as string] : []), ...(await findFoldersByCode(code)).map(f => f.id)])]
      // v1.260 — clips an unformatted card still lists from an earlier shoot do not hold the notice (they are named in the text)
      const gate = await mediaproGate(roots, { shootFrom: new Date(b.shootDate).toISOString().slice(0, 10) })
      if (!gate.ok) {
        result.skipped.push({ code, reason: 'mediapro-incomplete', detail: gate.text })
        // v1.274 — remember WHY, so the health check and the 📣 preview can say "files missing"
        // after this booking ages out of the window (re-running this gate costs minutes of Drive walks)
        // only a comparison that ran is evidence of missing files; check:null = "could not check" — keep any earlier verdict
        if (!dryRun && gate.check) await noteHeld(b, code, gate.text, payload.fileCount, payload.folders.reduce((n, f) => n + f.totalBytes, 0), now)
        continue
      }
      // the gate passed: an earlier hold is no longer true (a camera wait or failed send can still age this one out)
      if (!dryRun && readHeld(b.readySnapshot)) {
        const { held: _gone, ...rest } = b.readySnapshot as Record<string, unknown>
        await prisma.booking.update({ where: { id: b.id }, data: { readySnapshot: rest as any } })
          .catch(e => console.error('[footage-ready] clear held failed:', code, e?.message || e))
      }
      // v1.267 — a camera booked but not on Drive yet (or audio only): wait, then send WITH the warning (never age out silently)
      let verified = gate.text
      const cov = cameraCoverage(gate.files || [], b, gate.check?.twinCopies)
      if (cov.gap) {
        const waitUntil = cameraWaitUntil(b.shootEndDate || b.shootDate, lookbackDays, settleMs)
        if (forced.length === 0 && now.getTime() < waitUntil) {
          result.skipped.push({ code, reason: 'camera-incomplete', detail: `${cov.gap} — รอถึง ${new Date(waitUntil).toISOString().slice(0, 16)}Z` })
          continue
        }
        verified = `${gate.text} · ⚠️ ${cov.gap}`
      }

      if (dryRun) {
        result.notified.push(code) // would notify
        continue
      }

      inactive ??= await inactiveUserEmails()
      const sent = await sendFootageReadyNotification(b, payload, audience, verified, inactive)
      if (!sent.delivered) {
        result.errors.push({ code, error: sent.error || 'no delivery channel succeeded' })
        continue // no stamp — retried next sweep
      }
      // Send-once stamp — CAS so a racing manual 📣 doesn't double-stamp.
      await prisma.booking.updateMany({
        where: { id: b.id, readyNotifiedAt: null },
        data: { readyNotifiedAt: new Date() },
      })
      logAudit({
        actorEmail: 'footage-ready-worker',
        action: 'booking.auto_notified_ready',
        entityType: 'Booking',
        entityId: b.id,
        bookingCode: code,
        changes: {
          audience,
          recipients: sent.recipients,
          ...(sent.skippedInactive.length ? { skippedInactive: sent.skippedInactive } : {}),
          folderCount: payload.folders.length,
          fileCount: payload.fileCount,
          mediapro: verified,
          ...(cov.gap ? { cameraGap: cov.gap, cameraCams: cov.cams } : {}), // v1.268 — the follow-up pass looks for this
          emailError: sent.error,
          forced: forced.length > 0 || undefined,
          // v1.186 — ผลจริงของช่องทาง operator: ตอบคำถาม "เขาได้ยินไหม" ได้จาก audit
          // โดยไม่ต้องเดา (Discord คือช่องทางของ operator ตามที่ตกลง 2026-08-21 · เมล digest
          // ส่งหาตัวเองผ่าน Gmail SMTP บัญชีเดียวกันเข้า Inbox ได้จริง — v1.248–v1.262.1 ตัดทิ้งเพราะเชื่อผิด)
          operatorChannels: sent.operatorChannels,
        },
      })
      result.notified.push(code)
    } catch (e: any) {
      result.errors.push({ code, error: e?.message || String(e) })
    }
  }

  return result
}

// ── Follow-up when the missing cameras arrive (v1.268) ──────────────────────
// นัท 11 ต.ค. 2569: "ทำแจ้งซ้ำตอนกล้องตามมาครบด้วย" — ใบที่ถูกแจ้งพร้อม "⚠️ มีไฟล์ภาพ 2/3 กล้อง" (v1.267 รอจนเกือบหน้าต่างปิด)
// ได้ฉบับที่สองเมื่อกล้องที่ขาดขึ้น Drive ครบ + ไฟล์หยุดเข้ามาแล้ว settle + MEDIAPRO ครบ · สถานะเก็บใน audit (ไม่แก้ schema):
// แถว booking.auto_notified_ready ที่มี cameraGap และยังไม่มีแถว booking.ready_followup ของใบนั้น

export const FOLLOWUP_DAYS = 7
const FOLLOWUP_MAX_PER_RUN = 5
// ponytail: in-process state (reset on restart) — rotation so 5 bookings that never resolve cannot starve the rest
// (review v1.268, same class as orderForWalk v1.179), and a guard so a sent follow-up whose audit insert failed is not
// re-sent by the next sweep. Upgrade path if restarts start to matter: a Booking column.
const followUpCheckedAt = new Map<string, number>()
const followUpSent = new Set<string>()

/** newest createdTime/modifiedTime among the files (ms) — "still arriving" without a stored snapshot */
export function newestFileAt(files: Array<{ createdTime?: string | null; modifiedTime?: string | null }>): number {
  let t = 0
  for (const f of files) for (const v of [f.createdTime, f.modifiedTime]) { const ms = v ? Date.parse(v) : NaN; if (Number.isFinite(ms) && ms > t) t = ms }
  return t
}

const GAP_RE = /(มีไฟล์ภาพ (\d+)\/\d+ กล้อง[^·]*|ยังไม่มีไฟล์ภาพ[^·]*)/
/**
 * The camera gap a notice went out with, and how many cameras had video then. v1.268 rows carry `cameraGap` +
 * `cameraCams`; v1.267 rows (live before this) only have it inside `mediapro` ("… · ⚠️ มีไฟล์ภาพ 2/3 กล้อง (…)").
 */
export function noticeGap(changes: unknown): { gap: string; cams: number } | null {
  const c = (changes || {}) as Record<string, any>
  if (typeof c.cameraGap === 'string') {
    return { gap: c.cameraGap, cams: Array.isArray(c.cameraCams) ? c.cameraCams.length : Number(GAP_RE.exec(c.cameraGap)?.[2] || 0) }
  }
  const m = typeof c.mediapro === 'string' && c.mediapro.includes('⚠️') ? GAP_RE.exec(c.mediapro) : null
  return m ? { gap: m[1].trim(), cams: Number(m[2] || 0) } : null
}

const isFootageFile = (f: { name: string }) => VIDEO_EXT.test(f.name) || !!sonyClipPart(f.name)

async function followUpCameraGaps(result: FootageReadyScanResult): Promise<void> {
  const now = new Date()
  const settleMs = envInt('FOOTAGE_READY_SETTLE_MS', 2 * 60 * 60_000)
  try {
    const notices = await prisma.auditLog.findMany({
      where: { action: { in: ['booking.auto_notified_ready', 'booking.notified_ready'] }, at: { gte: new Date(now.getTime() - FOLLOWUP_DAYS * DAY) } },
      orderBy: { at: 'asc' },
      select: { entityId: true, bookingCode: true, at: true, action: true, changes: true },
    })
    // the LATEST notice per booking decides: a later 📣 or a later clean re-notify means nothing is owed (review: duplicates)
    const latest = new Map<string, (typeof notices)[number]>()
    for (const n of notices) if (n.entityId) latest.set(n.entityId, n)
    const owed = [...latest.values()]
      .map(n => ({ n, first: n.action === 'booking.auto_notified_ready' ? noticeGap(n.changes) : null }))
      .filter((x): x is { n: (typeof notices)[number]; first: { gap: string; cams: number } } => !!x.first && !followUpSent.has(x.n.entityId!))
    if (!owed.length) return
    const followed = await prisma.auditLog.findMany({
      where: { action: 'booking.ready_followup', entityId: { in: owed.map(x => x.n.entityId!) } },
      select: { entityId: true, at: true },
    })
    const todo = owed
      .filter(x => !followed.some(f => f.entityId === x.n.entityId && f.at >= x.n.at))
      .sort((a, b) => (followUpCheckedAt.get(a.n.entityId!) || 0) - (followUpCheckedAt.get(b.n.entityId!) || 0))
    const nasState = await latestNasState().catch(() => ({ manifest: null, statuses: {} as Record<string, any> }))
    const nasStatuses = nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale ? (nasState.statuses || {}) : {}
    for (const { n: w, first } of todo.slice(0, FOLLOWUP_MAX_PER_RUN)) {
      const code = w.bookingCode || w.entityId!
      followUpCheckedAt.set(w.entityId!, now.getTime())
      const wait = (detail: string) => { result.followUpWaiting.push({ code, detail }) }
      try {
        // same "nothing owed any more" rules as the first notice: ส่งงานแล้ว / ขอยกเลิก / ยกเลิก / ลบ
        const b = await prisma.booking.findFirst({
          where: { id: w.entityId!, deletedAt: null, deliveredAt: null, cancelRequestedAt: null, status: { in: ['CONFIRMED', 'COMPLETED'] } },
          select: CANDIDATE_SELECT,
        }) as unknown as CandidateRow | null
        if (!b) continue
        // gate (c) / (d) of the first notice: still uploading, or the NAS still sending this code
        const inFlight = await prisma.upload.count({
          where: { bookingId: b.id, status: { in: ['PENDING', 'UPLOADING'] }, updatedAt: { gte: new Date(now.getTime() - DAY) } },
        })
        if (inFlight > 0) { wait('ยังอัปโหลดอยู่'); continue }
        if ((nasStatuses[code]?.lastPending || 0) > 0) { wait('NAS ยังส่งไม่หมด'); continue }
        const box = (b.driveFolders as Record<string, unknown> | null)?.box
        const boxState = typeof box === 'string' ? await folderLiveness(box) : 'dead'
        if (boxState === 'unknown') { wait('ตรวจกล่องไม่ได้ (Drive)'); continue }
        const roots = [...new Set([...(boxState === 'alive' ? [box as string] : []), ...(await findFoldersByCode(code)).map(f => f.id)])]
        const gate = await mediaproGate(roots, { shootFrom: new Date(b.shootDate).toISOString().slice(0, 10) })
        if (!gate.ok) { wait(gate.text); continue }
        const cov = cameraCoverage(gate.files || [], b, gate.check?.twinCopies)
        if (cov.gap) { wait(cov.gap); continue }
        // "the cameras arrived" must be TRUE, not "the rule went quiet" (review): countable, and more cameras than at the notice
        if (cov.uncounted) { wait('นับกล้องไม่ได้ (มีภาพอยู่นอกโฟลเดอร์ CAM-x) — ไม่ส่งฉบับ "กล้องครบ"'); continue }
        if (cov.cams.length <= first.cams) { wait(`ไม่มีกล้องใหม่ขึ้นมา (${cov.cams.length} กล้องเท่าตอนแจ้ง) — จำนวนกล้องในใบอาจถูกแก้`); continue }
        if (now.getTime() - newestFileAt((gate.files || []).filter(isFootageFile)) < settleMs) { wait('ไฟล์ยังทยอยเข้า — รอให้นิ่ง'); continue }
        if (result.dryRun) { result.followedUp.push(code); continue }
        const sent = await sendCameraFollowUp(b, w, cov, gate.text, gate.files?.length || 0)
        if (!sent.delivered) { result.errors.push({ code, error: `follow-up: ${sent.error || 'no channel'}` }); continue } // retried next sweep
        followUpSent.add(w.entityId!)
        result.followedUp.push(code)
        try {
          // awaited + throwing (not logAudit, which swallows): this row is the send-once record
          await prisma.auditLog.create({
            data: {
              actorEmail: 'footage-ready-worker', action: 'booking.ready_followup', entityType: 'Booking', entityId: b.id, bookingCode: code,
              changes: JSON.parse(JSON.stringify({
                audience: result.audience, recipients: sent.recipients, ...(sent.skippedInactive.length ? { skippedInactive: sent.skippedInactive } : {}),
                cameraGapBefore: first.gap, cams: cov.cams, fileCount: gate.files?.length || 0, mediapro: gate.text,
                emailError: sent.error, operatorChannels: sent.operatorChannels,
              })),
            },
          })
        } catch (e: any) {
          result.errors.push({ code, error: `follow-up ส่งแล้วแต่บันทึกไม่ลง (จะไม่ส่งซ้ำจนกว่าคอนเทนเนอร์รีสตาร์ท): ${e?.message || e}` })
        }
      } catch (e: any) {
        result.errors.push({ code, error: `follow-up: ${e?.message || e}` })
      }
    }
    if (todo.length > FOLLOWUP_MAX_PER_RUN) result.followUpWaiting.push({ code: '…', detail: `อีก ${todo.length - FOLLOWUP_MAX_PER_RUN} ใบ ผลัดตรวจรอบถัดไป` })
  } catch (e: any) {
    result.errors.push({ code: 'follow-up', error: e?.message || String(e) }) // loud: a broken pass must not look like "nothing to follow up"
  }
}

async function sendCameraFollowUp(
  b: CandidateRow,
  first: { at: Date },
  cov: CameraCoverage,
  verified: string,
  fileCount: number,
): Promise<{ delivered: boolean; recipients: string[]; skippedInactive: string[]; operatorChannels: { digestOk: boolean; discordOk: boolean; larkOk: boolean }; error: string | null }> {
  const code = b.bookingCode as string
  const show = bookingDisplayName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'
  const box = (b.driveFolders as Record<string, unknown> | null)?.box
  const firstAt = new Date(first.at.getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
  const subject = `[Footage ครบแล้ว] ${code} — ${show}`
  const text = `กล้องที่ยังขาดตอนแจ้ง "ฟุตเทจพร้อม" ครั้งแรก ตามมาครบแล้ว ✅ (แจ้งอัตโนมัติโดยระบบ)
${b.outlet.name} · ${show} · ${new Date(b.shootDate).toISOString().slice(0, 10)}

ไฟล์ภาพครบ ${cov.cams.length} กล้อง${cov.cams.length ? ` (${cov.cams.join(', ')})` : ''} · ${fileCount} ไฟล์
✔︎ ${verified}
แจ้งครั้งแรก ${firstAt} น.
${typeof box === 'string' ? `\nเปิดกล่องงาน: https://drive.google.com/drive/folders/${box}` : ''}
เปิดในระบบ: ${appUrl}/upload?bookingId=${b.id}

THE STANDARD Production Booking`
  const audience = footageReadyAudience()
  const { people, digest, inactive } = footageReadyRecipients(audience, b, process.env.REMINDER_ADMIN_EMAIL || process.env.EMAIL_FROM, await inactiveUserEmails())
  let emailed = 0
  let error: string | null = null
  if (people.length && isEmailConfigured()) {
    const results = await Promise.allSettled(people.map(to => sendEmail({ to: [to], subject, text })))
    emailed = results.filter(r => r.status === 'fulfilled').length
    if (emailed < results.length) error = `${results.length - emailed}/${results.length} ส่งไม่สำเร็จ`
  } else if (!people.length) error = 'ไม่มีคนในทีมให้แจ้ง'
  else error = 'email not configured'
  const digestOk = digest || !people.length ? await notifyEmailDigest(subject, text) : false
  const { discord: discordOk, lark: larkOk, any: chatOk } = await notifyChatDetailed(`✅ กล้องตามมาครบ: ${code} — ${show} (${cov.cams.join(', ') || 'ไฟล์ภาพครบ'}) → ${emailed}/${people.length} อีเมล`)
  return {
    delivered: emailed > 0 || (!isEmailConfigured() && chatOk) || (people.length === 0 && (digestOk || chatOk)),
    recipients: digestOk ? [...people, ADMIN_DIGEST] : people,
    skippedInactive: inactive,
    operatorChannels: { digestOk, discordOk, larkOk },
    error,
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

async function sendFootageReadyNotification(
  b: CandidateRow,
  payload: FootagePayload,
  audience: FootageReadyAudience,
  verified: string,
  inactiveEmails: string[],
): Promise<{
  delivered: boolean
  recipients: string[]
  /** v1.264 — คนในใบที่ปิดบัญชีแล้ว ไม่ได้ส่ง (บันทึกลง audit) */
  skippedInactive: string[]
  /**
   * v1.186 — ผลจริงของช่องทางฝั่ง operator (ไม่ใช่ "เจตนาว่าจะส่ง")
   *
   * WHY. ก่อนหน้านี้ `'admin-digest'` ถูกต่อเข้า `recipients` จากตัวแปร `alsoDigest`
   * ล้วน ๆ และค่าที่ notifyEmailDigest/notifyDiscord คืนมาถูกทิ้งทั้งคู่ → audit
   * บันทึกว่า operator ได้รับ **85/85 ครั้งใน 30 วัน โดยไม่มี error** ขณะที่เจ้าตัว
   * ไม่ได้เมลเลยแม้ฉบับเดียว (เมล digest เป็น From=To=อีเมลเดียวกัน ส่งผ่าน Gmail
   * SMTP ของบัญชีตัวเอง จึงไม่เข้า Inbox) — บันทึกที่รายงานไม่ตรงของจริงทำให้
   * ทั้ง /stats และคนอ่านสรุปผิดว่า "แจ้งแล้ว"
   * ⚠️ 9 ต.ค. 2569: ข้อสรุป "เมลหาตัวเองไม่เข้า Inbox" ผิด — Inbox นัทมีเมลพวกนี้ (ป้าย INBOX) ถึง 30 ก.ย.
   * กฎ "บันทึกผลจริง ไม่ใช่เจตนา" ยังถูก · ดู digestRecipients() v1.262.2
   */
  operatorChannels: { digestOk: boolean; discordOk: boolean; larkOk: boolean }
  error: string | null
}> {
  const code = b.bookingCode as string
  const show = bookingDisplayName({ projectName: b.projectName, program: b.program, episodes: b.episodes })
  const shootDate = new Date(b.shootDate).toISOString().slice(0, 10)
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'
  const totalBytes = payload.folders.reduce((n, f) => n + f.totalBytes, 0)
  const folderLines = payload.folders.map(f => `• ${f.label} — ${f.fileCount} ไฟล์ · ${formatBytes(f.totalBytes)}\n  ${f.url}`).join('\n')
  const subject = `[Footage พร้อม] ${code} — ${show}`
  // Same body shape as the manual 📣 notify-ready, marked as automatic.
  const text = `footage ของ ${code} พร้อมแล้ว ✅ (แจ้งอัตโนมัติโดยระบบ)
${b.outlet.name} · ${show} · ${shootDate} ${b.callTime}

— โฟลเดอร์ footage (${payload.folders.length} โฟลเดอร์ · ${payload.fileCount} ไฟล์ · ${formatBytes(totalBytes)}) —
${folderLines}
✔︎ ${verified}
${payload.bookingFolderUrl ? `\nเปิดกล่องงานทั้งหมด: ${payload.bookingFolderUrl}` : ''}

เปิดในระบบ: ${appUrl}/upload?bookingId=${b.id}

THE STANDARD Production Booking`

  const discordLine = `📣 auto-แจ้งไฟล์พร้อม: ${code} — ${show} (${payload.fileCount} ไฟล์ · ${formatBytes(totalBytes)})`

  if (audience === 'admin') {
    const emailOk = await notifyEmailDigest(subject, text)
    const { discord: discordOk, lark: larkOk, any: chatOk } = await notifyChatDetailed(discordLine)
    return {
      delivered: emailOk || chatOk,
      // ใส่ ADMIN_DIGEST เฉพาะเมื่อส่งผ่านจริง — ไม่ใช่เพราะ "ตั้งใจจะส่ง"
      recipients: emailOk ? [ADMIN_DIGEST] : [],
      skippedInactive: [],
      operatorChannels: { digestOk: emailOk, discordOk, larkOk },
      error: emailOk || chatOk ? null : 'admin digest + chat (discord/lark) both unavailable',
    }
  }

  const { people: recipients, digest: alsoDigest, inactive: skippedInactive } = footageReadyRecipients(
    audience,
    b,
    process.env.REMINDER_ADMIN_EMAIL || process.env.EMAIL_FROM,
    inactiveEmails,
  )

  if (recipients.length === 0) {
    // No producer email — tell the admin instead of retrying forever.
    // Caller stamps readyNotifiedAt, so this warns exactly once per booking.
    // v1.264 — ทุกคนในใบปิดบัญชีแล้ว = บอกชื่อ (ต้องหาคนรับงานแทน) ไม่ใช่ "ไม่มีอีเมล"
    const why = skippedInactive.length ? `คนในใบออกไปแล้วทั้งหมด (${skippedInactive.join(', ')})` : 'booking ไม่มี producerEmail ให้แจ้ง'
    const warned = await notifyEmailDigest(`⚠️ ${subject} — ไม่มีคนในทีมให้แจ้ง`, `${code} footage พร้อมแล้ว แต่${why}\n\n${text}`)
    const { discord: discordOk, lark: larkOk, any: chatOk } = await notifyChatDetailed(`⚠️ ${discordLine} — ไม่มีคนในทีมให้แจ้ง: ${why}`)
    return {
      delivered: warned || chatOk,
      recipients: [],
      skippedInactive,
      operatorChannels: { digestOk: warned, discordOk, larkOk },
      error: skippedInactive.length ? 'all team members inactive' : 'no producer email',
    }
  }

  let emailed = 0
  let error: string | null = null
  if (isEmailConfigured()) {
    // One email PER recipient — assignedEmails can include external freelancers'
    // personal addresses (same privacy rule as the manual notify-ready).
    const results = await Promise.allSettled(recipients.map(to => sendEmail({ to: [to], subject, text })))
    emailed = results.filter(r => r.status === 'fulfilled').length
    if (emailed < results.length) error = `${results.length - emailed}/${results.length} ส่งไม่สำเร็จ`
  } else {
    error = 'email not configured'
  }
  // The operator keeps his overview copy on top of the team's mails (v1.178).
  // Best-effort and never counted as delivery: if the digest is the ONLY thing
  // that got through, the team still did not hear about it, and reporting that
  // as success is how the old "ส่งให้ผมคนเดียว" state stayed invisible.
  //
  // v1.186 — เก็บค่าที่คืนมา (เดิมทิ้ง) เพราะมันคือคำตอบของคำถาม "operator ได้ยินไหม"
  const digestOk = alsoDigest ? await notifyEmailDigest(subject, text) : false

  // Discord summary is best-effort on top of email; it also serves as the
  // fallback channel when email is unavailable.
  const { discord: discordOk, lark: larkOk, any: chatOk } = await notifyChatDetailed(`${discordLine} → ${emailed}/${recipients.length} อีเมล`)

  return {
    delivered: emailed > 0 || (!isEmailConfigured() && chatOk),
    // v1.186 — ADMIN_DIGEST เข้ารายชื่อเฉพาะเมื่อส่งผ่านจริง (เดิมใส่ตาม alsoDigest
    // ล้วน ๆ ทำให้ /stats นับว่า operator ได้รับ ทั้งที่ไม่เคยได้)
    recipients: digestOk ? [...recipients, ADMIN_DIGEST] : recipients,
    skippedInactive,
    operatorChannels: { digestOk, discordOk, larkOk },
    error,
  }
}
