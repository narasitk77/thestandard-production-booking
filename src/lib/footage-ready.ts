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
 *                      v1.277: a field-ingest card (`CARD_…` row, src/lib/ingest.ts)
 *                      holds with NO expiry while UPLOADING or ORPHANED — a parked
 *                      "proxies first" run or a dead laptop must never time out into
 *                      "พร้อม"; FAILED (set by an admin) is the only release. A card
 *                      silent 20 min and not parked is flipped to ORPHANED + alertOps.
 *   d) NAS drained   — the NAS queue for this code is absent or lastPending=0
 *   e) footage exists— fresh Drive walk (sweepFootagePayload — dryRun too)
 *                      sees >0 folders and >0 files. The Drive walk is the ONLY
 *                      signal that covers BOTH delivery paths (browser uploads
 *                      AND NAS→video-merge, which creates no Upload rows)
 *   f) settled       — fileCount+totalBytes unchanged for FOOTAGE_READY_SETTLE_MS
 *                      (default 2 h — covers the "dump card 1 → travel/dinner →
 *                      dump card 2" gap) across sweeps, so a multi-batch card
 *                      dump doesn't fire after the first batch
 *                      v1.287 — OR, when MEDIAPRO can vouch for the whole box
 *                      (fastPathBlocker === ''), unchanged for only
 *                      FOOTAGE_READY_VERIFIED_SETTLE_MS (default 20 min = one sweep
 *                      later). Anything MEDIAPRO cannot vouch for keeps the long wait.
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
import { isMcpActorEmail } from './mcp/auth'
import { prisma } from './db'
import { logAudit } from './audit'
import { sendEmail, isEmailConfigured } from './email'
import { notifyChatDetailed, notifyEmailDigest } from './notify'
import { getCachedFootagePayload, computeFootagePayload, type FootagePayload, type BookingForFootagePayload } from './footage-folders'
import { isPhotoAlbumBooking, bookingNeedsSound } from './outlet-folders'
import { isShootOver, shootEndsAt, type ShootWindow } from './shoot-window'
import { latestNasState, nasManifestAge } from './nas-sync'
import { PHOTO_ALBUM_EPISODE_CODE } from './outlet-folders'
import { formatBytes } from './footage-report'
import { bookingDisplayName } from './display'
import { ADMIN_DIGEST, readHeld } from './footage-ready-health'
import { mediaproGate, expectsCameraVideo, sameClip } from './mediapro'
import { folderLiveness, findFoldersByCode } from './google-drive'
import { markCalendarFootageReady } from './google-calendar'
import { getDriveLink } from './drive-links'
import { baseName, isQuarantined, sonyClipPart, type FootageFileLike } from './footage-completeness'
import { alertOps } from './ops-alert'
import { CARD_PREFIX, isStaleCard, cardHoldsNotice } from './ingest'
import { EPISODE_ORDER } from './episode-order'

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
  const expectVideo = expectsCameraVideo(b)
  const list = [...cams].sort()
  let gap = ''
  if (expectVideo && video === 0) gap = 'ยังไม่มีไฟล์ภาพจากกล้องเลย (มีแต่ไฟล์อื่น เช่น เสียง)'
  else if (!uncounted && expected > 0 && cams.size < expected) gap = `มีไฟล์ภาพ ${cams.size}/${expected} กล้อง (${list.join(', ') || '—'})`
  return { video, cams: list, uncounted, gap }
}

// ── MEDIAPRO fast path (v1.287) ─────────────────────────────────────────────
// นัท 12 พ.ย. 2569: "rule 4 ชม หลังไฟล์ไม่เข้ายังช้าอยู่ อยากให้เช็คได้เลยว่าไฟล์ครบไหมจาก Mediapro แล้วถ้าครบแล้ว
// แจ้งได้เลย แต่ถ้างานไหนไม่มี ก็ใช้กฎเดิม" · ข้อ (f) รอ 4 ชม. เพราะ "ไฟล์หยุดเข้า" เป็นหลักฐานเดียวที่มี — แต่การ์ด
// Sony บอกเองว่ามีไฟล์อะไรบ้าง ถ้ากล่องมีครบทุกไฟล์ที่ MEDIAPRO ระบุ ก็ไม่ต้องเดาจากความเงียบ
// "ครบ" ต้องพูดได้ทั้งกล่อง ไม่ใช่แค่การ์ดที่อยู่ตรงหน้า: ภาพจากกล้องที่ไม่ใช่ Sony (ไม่มี MEDIAPRO) · กล้องที่จองแต่ยังไม่มา ·
// ใบที่ไม่บอกว่าจองกี่กล้อง · ทีมเสียงที่ยังไม่มีไฟล์เสียง — MEDIAPRO รับรองแทนไม่ได้ → กฎเดิม
const AUDIO_EXT = /\.(wav|bwf|mp3|m4a|aif|aiff|flac)$/i

type GateResult = Awaited<ReturnType<typeof mediaproGate>>

/**
 * '' = MEDIAPRO vouches for every piece of footage this booking expects → no need to wait out the 4h settle.
 * Otherwise one Thai line: why this booking keeps the old rule. Pure (the gate already walked Drive).
 * A card that never reached the NAS/Drive at all is invisible to this and to every other gate — the
 * short settle (one sweep) plus the NAS-drained gate are what cover a card still being copied.
 */
export function fastPathBlocker(
  gate: GateResult | null,
  b: { cameraCount?: number | null; crewRequired?: string[] | null } & ShootWindow,
): string {
  if (!gate) return 'ตรวจกล่องไม่ได้ (Drive)'
  if (!gate.ok) return gate.text
  if (!gate.check || gate.check.cards === 0) return 'ไม่มี MEDIAPRO ให้เทียบ'
  const files = (gate.files || []).filter(f => !isQuarantined(f))
  // Sony originals no card lists are already `unverifiable` (gate not ok); this catches every other camera — and a
  // custom-named Sony clip (title prefix) counts only when a MEDIAPRO actually lists it (review r1/r2)
  const cards = gate.cards || []
  const listed = new Set(cards.flatMap(c => c.materials.flatMap(m => m.files.map(r => baseName(r.split('/').pop() || '').toUpperCase()))))
  const loose = files.filter(f => VIDEO_EXT.test(f.name) && !sonyClipPart(f.name) && !listed.has(baseName(f.name).toUpperCase()))
  if (loose.length) return `มีไฟล์ภาพที่ไม่มี MEDIAPRO ${loose.length} ไฟล์ (${loose.slice(0, 2).map(f => f.name).join(', ')}${loose.length > 2 ? ' …' : ''})`
  // review — one card dumped into two camera folders counts as two cameras and hides the one still missing
  const camOf = (p: string[]) => p.map(s => CAM_DIR.exec(stripDup(s))).find(Boolean)?.[1].toUpperCase() || ''
  const twin = cards.find((a, i) => cards.slice(i + 1).some(c => camOf(a.folderPath) && camOf(c.folderPath) && camOf(a.folderPath) !== camOf(c.folderPath)
    && a.materials.some(m => c.materials.some(n => sameClip(m, n)))))
  if (twin) return `การ์ดเดียวกันอยู่ในโฟลเดอร์กล้องสองตัว (${twin.folderPath.join('/')}) — นับกล้องไม่ได้`
  const cov = cameraCoverage(files, b, gate.check.twinCopies)
  if (cov.gap) return cov.gap
  if (!(b.cameraCount && b.cameraCount > 0)) return 'ใบจองไม่ระบุจำนวนกล้อง — บอกไม่ได้ว่ากล้องมาครบ'
  // review r2 — camera A's 2nd card filed under CAM-B still reads as "camera B arrived". FX6/FX3 names carry the camera
  // ID letter (A009C001_…): when every original has one, fewer letters than cameras booked = a camera is still missing.
  // (43 real jobs, 30 days: the team sets distinct IDs — only one job had fewer letters, and it was not fast anyway.)
  const origs = files.filter(f => sonyClipPart(f.name)?.part === 'orig')
  const letters = new Set<string | undefined>(origs.map(f => (/^([A-Z])\d{3}[A-Z]\d{3}_/i.exec(baseName(f.name)) || [])[1]?.toUpperCase()))
  if (origs.length && !letters.has(undefined) && letters.size < b.cameraCount) {
    return `คลิปมาจากกล้อง ${letters.size} ตัว (${[...letters].sort().join(', ')}) แต่จอง ${b.cameraCount} ตัว — อาจเป็นการ์ดใบที่สองของกล้องเดิม`
  }
  if (cov.uncounted) return 'มีไฟล์ภาพนอกโฟลเดอร์ CAM-x — นับกล้องไม่ได้'
  if (bookingNeedsSound(b.crewRequired) && !files.some(f => AUDIO_EXT.test(f.name))) return 'ใบจองมีทีมเสียง แต่ยังไม่มีไฟล์เสียง'
  // review (confirmed) — cards dumped DURING the shoot (field ingest at lunch, day 1 of a multi-day job) are complete per
  // MEDIAPRO and cover every camera, while the last cards are still with the crew: the first walk after wrap would send.
  // Some camera footage must have reached Drive after the (last day's) wrap. Audio is left out: sound-merge's box
  // copies are stamped when copied, not when they arrived. No createdTime = cannot tell = no.
  // A clip's arrival = its EARLIEST copy: a sync-storm "(1)" re-upload or a re-copied lunch card is not new footage (review r2)
  const ends = shootEndsAt(b).getTime()
  const arrived = new Map<string, number>()
  for (const f of files) {
    if (!isFootageFile(f)) continue
    const t = Date.parse((f as { createdTime?: string | null }).createdTime || '')
    const k = baseName(f.name).toUpperCase()
    if (Number.isFinite(t)) arrived.set(k, Math.min(arrived.get(k) ?? t, t))
  }
  if (![...arrived.values()].some(t => t > ends)) {
    return `ไฟล์ภาพทั้งหมดขึ้น Drive ก่อนเลิกกอง (${new Date(ends + 7 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')}) — การ์ดชุดสุดท้ายอาจยังอยู่กับทีม`
  }
  return ''
}

/** v1.287 — the fast path already said no for exactly these counts → not again until the footage changes (each try walks Drive). */
export function readFastNo(snapshot: unknown, counts: { fileCount: number; totalBytes: number }): string | null {
  const f = (snapshot as { fast?: { detail?: unknown; fileCount?: unknown; totalBytes?: unknown } } | null | undefined)?.fast
  return f && typeof f.detail === 'string' && f.fileCount === counts.fileCount && f.totalBytes === counts.totalBytes ? f.detail : null
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
  // v1.276 — the MCP actor is an identity, not a mailbox
  let people = Array.from(new Set(raw.map(clean).filter(e => e.includes('@') && !isMcpActorEmail(e))))
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
  /**
   * v1.287 — bookings past the short settle that the MEDIAPRO fast path judged: ok = MEDIAPRO vouched, so the notice
   * went ahead without waiting out FOOTAGE_READY_SETTLE_MS (whether it was DELIVERED is `notified` / `errors`, as for
   * every notice) · !ok = keeps the old rule, with why · cached = judged on an earlier sweep for these exact counts
   */
  fast: Array<{ code: string; ok: boolean; detail: string; cached: boolean }>
  /** v1.287 — fast-path notices (last FAST_WATCH_DAYS) after which more footage started arriving; ops is told once (dry run: would tell) */
  fastMore: Array<{ code: string; detail: string }>
  /** v1.288 — calendar events given ✅ + the box link this sweep (dry run: would mark) — notices of the last READY_MARK_DAYS */
  calendarMarked: string[]
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
  calendarEventId?: string | null
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
  id: true, bookingCode: true, status: true, driveFolders: true, calendarEventId: true,
  projectId: true, projectName: true, category: true, crewRequired: true,
  producer: true, producerEmail: true, coProducerEmail: true, createdByEmail: true, assignedEmails: true,
  directorEmail: true, director2Email: true, director3Email: true, cameraCount: true,
  callTime: true, shootDate: true, shootEndDate: true, estimatedWrap: true,
  readySnapshot: true, readyCheckedAt: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true, code: true } },
  episodes: {
    // maint 2026-11-08 — total order (sequence ties on multi-item bookings → the show name in the mail flipped run to run)
    orderBy: EPISODE_ORDER,
    select: { episodeId: true, sequence: true, title: true, program: { select: { name: true, code: true } } },
  },
}

export async function sweepFootagePayload(b: BookingForFootagePayload, dryRun: boolean): Promise<FootagePayload> {
  return dryRun ? computeFootagePayload(b) : getCachedFootagePayload(b, { refresh: true })
}

/**
 * Gate (g)'s Drive check: the LIVE box plus every folder named with this code (a drop folder still holding a
 * half-copied card counts) — the same places the email announces. null = Drive could not say whether the box is alive.
 */
async function mediaproGateFor(b: CandidateRow, code: string): Promise<GateResult | null> {
  const box = (b.driveFolders as Record<string, unknown> | null)?.box
  const boxState = typeof box === 'string' ? await folderLiveness(box) : 'dead'
  if (boxState === 'unknown') return null
  const roots = [...new Set([...(boxState === 'alive' ? [box as string] : []), ...(await findFoldersByCode(code)).map(f => f.id)])]
  // v1.260 — clips an unformatted card still lists from an earlier shoot do not hold the notice (they are named in the text)
  return mediaproGate(roots, { shootFrom: new Date(b.shootDate).toISOString().slice(0, 10) })
}

/** v1.287 — `readySnapshot.fast` (see readFastNo). A changed count rewrites the snapshot, which drops it. */
async function noteFastNo(b: { id: string; readySnapshot: unknown }, code: string, detail: string, counts: { fileCount: number; totalBytes: number }, now: Date): Promise<void> {
  const base = b.readySnapshot && typeof b.readySnapshot === 'object' ? (b.readySnapshot as Record<string, unknown>) : {}
  await prisma.booking.update({
    where: { id: b.id },
    data: { readySnapshot: { ...base, fast: { detail, ...counts, at: now.toISOString() } } as any },
  }).catch(e => console.error('[footage-ready] noteFastNo failed:', code, e?.message || e))
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
  if (result.forced.length === 0) {
    await followUpCameraGaps(result)
    await watchFastNotices(result)
    await markReadyCalendars(result)
  }
  return result
}

// ── v1.288 — ✅ + box link on the calendar event of every announced booking ─────
// One pass does all three jobs: the auto notice of this sweep, a 📣 / ?codes= notice whose inline mark failed, and
// the backfill of notices sent before v1.288. Done = an audit `booking.calendar_ready_marked` row for THIS event, THIS
// notice time and THIS box link (review v1.288): a re-created event, a second 📣 or a box id learnt later is marked
// again. 'gone' (deleted event) is recorded too so it is not retried forever. A Google error is LOUD (result.errors)
// and retried next sweep — rotated, so a handful of stuck ones cannot hold the 15 slots.
export const READY_MARK_DAYS = 30
const READY_MARK_MAX_PER_RUN = 15
// ponytail: in-process rotation (reset on restart, same as followUpCheckedAt)
const readyMarkTriedAt = new Map<string, number>()

/** what a done-record must match: event + notice instant + box link */
export const readyMarkKey = (eventId: string, readyAt: Date | string, boxId: string | null) => `${eventId}|${new Date(readyAt).toISOString()}|${boxId || ''}`

/** Mark one booking's event and record it. Never throws: { ok:false, error } = retry later. */
export async function markReadyOnCalendar(
  b: { id: string; bookingCode: string | null; calendarEventId: string | null; driveFolders: unknown; readyNotifiedAt: Date | null },
  actorEmail = 'footage-ready-worker',
  /** the 📣 already resolved the box the mail links to — use it when the booking has no stored box id */
  boxOverride: string | null = null,
): Promise<{ ok: boolean; state?: 'marked' | 'already' | 'gone' | 'no-event'; error?: string }> {
  if (!b.calendarEventId) return { ok: true, state: 'no-event' }
  if (!b.readyNotifiedAt) return { ok: false, error: 'not announced' }
  const boxId = getDriveLink(b.driveFolders, 'box') || boxOverride
  try {
    const state = await markCalendarFootageReady(b.calendarEventId, b.readyNotifiedAt, boxId)
    await logAudit({ actorEmail, action: 'booking.calendar_ready_marked', entityType: 'Booking', entityId: b.id, bookingCode: b.bookingCode,
      changes: { eventId: b.calendarEventId, readyAt: b.readyNotifiedAt.toISOString(), boxId, key: readyMarkKey(b.calendarEventId, b.readyNotifiedAt, boxId), state } })
    return { ok: true, state }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * The 📣's inline mark, with a hard deadline: the mail already went out, so a stalled Calendar must not keep the request
 * open until the proxy answers 504 (the UI would say "ส่งไม่สำเร็จ" and someone would mail the whole team again). The
 * sweep retries whatever this did not finish.
 */
export function markReadyOnCalendarWithin(
  b: Parameters<typeof markReadyOnCalendar>[0], actorEmail: string, boxOverride: string | null, ms = 15_000,
): ReturnType<typeof markReadyOnCalendar> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    markReadyOnCalendar(b, actorEmail, boxOverride),
    new Promise<{ ok: boolean; error: string }>(resolve => { timer = setTimeout(() => resolve({ ok: false, error: `calendar did not answer in ${ms / 1000}s` }), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function markReadyCalendars(result: FootageReadyScanResult): Promise<void> {
  try {
    const rows = (await prisma.booking.findMany({
      where: {
        deletedAt: null, cancelRequestedAt: null, status: { in: ['CONFIRMED', 'COMPLETED'] }, // a cancelled job's leftover event gets no ✅
        calendarEventId: { not: null }, readyNotifiedAt: { gte: new Date(Date.now() - READY_MARK_DAYS * DAY) },
      },
      select: { id: true, bookingCode: true, calendarEventId: true, driveFolders: true, readyNotifiedAt: true },
      orderBy: { readyNotifiedAt: 'desc' }, // the notice that just went out first — the backfill must not starve it
    })).filter((r): r is typeof r & { calendarEventId: string; readyNotifiedAt: Date } => !!r.calendarEventId && !!r.readyNotifiedAt)
    if (!rows.length) return
    const keys = (await prisma.auditLog.findMany({
      where: { action: 'booking.calendar_ready_marked', entityId: { in: rows.map(r => r.id) } },
      select: { changes: true },
    })).map(a => (a.changes as { key?: unknown } | null)?.key).filter((k): k is string => typeof k === 'string')
    const done = new Set(keys)
    // no stored box id: a mark made with the box the 📣 resolved for its mail still counts (re-marking here would
    // rewrite the line WITHOUT that link)
    const doneAnyBox = new Set(keys.map(k => k.split('|').slice(0, 2).join('|')))
    const isDone = (r: { calendarEventId: string; readyNotifiedAt: Date; driveFolders: unknown }) => {
      const box = getDriveLink(r.driveFolders, 'box')
      return done.has(readyMarkKey(r.calendarEventId, r.readyNotifiedAt, box)) ||
        (!box && doneAnyBox.has(readyMarkKey(r.calendarEventId, r.readyNotifiedAt, null).split('|').slice(0, 2).join('|')))
    }
    const todo = rows
      .filter(r => !isDone(r))
      .map((r, i) => ({ r, i }))
      .sort((x, y) => (readyMarkTriedAt.get(x.r.id) || 0) - (readyMarkTriedAt.get(y.r.id) || 0) || x.i - y.i)
      .map(x => x.r)
    // a dry run already counted this sweep's would-be notices (they take slots first in the real run: newest)
    const slots = READY_MARK_MAX_PER_RUN - (result.dryRun ? result.calendarMarked.length : 0)
    for (const r of todo.slice(0, Math.max(0, slots))) {
      const code = r.bookingCode || r.id
      if (result.dryRun) {
        // read-only: the same answer the real call would give (review v1.288 — a preview must match the run)
        try {
          const would = await markCalendarFootageReady(r.calendarEventId, r.readyNotifiedAt, getDriveLink(r.driveFolders, 'box'), { dryRun: true })
          if (would === 'marked') result.calendarMarked.push(code)
        } catch (e: any) { result.errors.push({ code, error: `calendar ✅: ${e?.message || e}` }) }
        continue
      }
      readyMarkTriedAt.set(r.id, Date.now())
      const m = await markReadyOnCalendar(r)
      if (m.ok) { if (m.state === 'marked') result.calendarMarked.push(code) }
      else result.errors.push({ code, error: `calendar ✅: ${m.error}` })
    }
    // no silent cap: say how many wait for the next sweep
    if (todo.length > slots) console.log(`[footage-ready] calendar ✅: อีก ${todo.length - Math.max(0, slots)} ใบ รอบถัดไป`)
  } catch (e: any) {
    result.errors.push({ code: 'calendar-mark', error: e?.message || String(e) })
  }
}

// ── v1.287 — after a fast notice, more footage = say so ─────────────────────
// The fast path trusts MEDIAPRO for the cards ON Drive; a card nobody has offloaded yet is invisible to every gate
// (review, confirmed high). Real data (43 jobs, 30 days) never showed it, so the window stays short — and the day it
// happens it must be loud, not silent: the NAS sending this code again, or a new upload row, after the notice.
export const FAST_WATCH_DAYS = 3

async function watchFastNotices(result: FootageReadyScanResult): Promise<void> {
  const now = new Date()
  try {
    const notices = (await prisma.auditLog.findMany({
      where: { action: { in: ['booking.auto_notified_ready', 'booking.ready_followup'] }, at: { gte: new Date(now.getTime() - FAST_WATCH_DAYS * DAY) } },
      select: { entityId: true, bookingCode: true, at: true, action: true, changes: true },
    })).filter(n => n.entityId && (n.changes as Record<string, unknown> | null)?.readyPath === 'mediapro')
    if (!notices.length) return
    const since = notices.reduce((m, n) => (n.at < m ? n.at : m), now)
    const codes = [...new Set(notices.map(n => n.bookingCode).filter((c): c is string => !!c))]
    // in flight NOW (fresh manifest only) — a failed read is said out loud, the other channels still run
    let nasStatuses: Record<string, any> = {}
    try {
      const st = await latestNasState()
      if (st.manifest && !nasManifestAge(st.manifest.at, now).stale) nasStatuses = st.statuses || {}
    } catch (e: any) {
      result.errors.push({ code: 'fast-watch', error: `อ่านสถานะ NAS ไม่ได้ — ช่องนี้ไม่ได้ตรวจรอบนี้: ${e?.message || e}` })
    }
    // durable records (review r2): a NAS batch that queued AND drained between two sweeps · a field card STARTED after
    // the notice (its CARD_ row may have been created as a ticket long before) · browser uploads (row created at start)
    const [events, uploads] = await Promise.all([
      prisma.auditLog.findMany({
        where: { action: { in: ['nas.folder_drained', 'ingest.start'] }, bookingCode: { in: codes }, at: { gte: since } },
        select: { action: true, bookingCode: true, at: true, changes: true },
      }),
      prisma.upload.findMany({
        where: { bookingId: { in: notices.map(n => n.entityId!) }, createdAt: { gte: since }, NOT: { fileName: { startsWith: CARD_PREFIX } } },
        select: { bookingId: true, createdAt: true, fileName: true },
      }),
    ])
    const watched = new Set<string>()
    for (const n of notices) {
      const code = n.bookingCode || n.entityId!
      if (watched.has(code)) continue // a fast notice and its fast follow-up: one alert
      const pending = nasStatuses[code]?.lastPending || 0
      // v1.288 — a drain is written DRAIN_SETTLE_MS after the queue emptied: judge it by when it emptied (changes.zeroSince)
      const emptiedAt = (e: (typeof events)[number]) => {
        const z = (e.changes as { zeroSince?: unknown } | null)?.zeroSince
        return typeof z === 'string' && Number.isFinite(Date.parse(z)) ? new Date(z) : e.at
      }
      const drained = events.filter(e => e.bookingCode === code && e.action === 'nas.folder_drained' && emptiedAt(e) > n.at).length
      const cards = events.filter(e => e.bookingCode === code && e.action === 'ingest.start' && e.at > n.at).length
      const fresh = uploads.filter(u => u.bookingId === n.entityId && u.createdAt > n.at)
      if (!pending && !drained && !cards && !fresh.length) continue
      watched.add(code)
      const why = [
        pending ? `NAS กำลังส่งของ ${code} อีก ${pending} ไฟล์` : '',
        drained ? `NAS ส่งชุดใหม่ของ ${code} ขึ้น Drive แล้ว ${drained} รอบ` : '',
        cards ? `ส่งการ์ดจากหน้างานเพิ่ม ${cards} ใบ` : '',
        fresh.length ? `อัปโหลดใหม่ ${fresh.length} รายการ (${fresh.slice(0, 2).map(u => u.fileName).join(', ')})` : '',
      ].filter(Boolean).join(' · ')
      result.fastMore.push({ code, detail: why })
      if (result.dryRun) continue
      const what = n.action === 'booking.ready_followup' ? 'Footage ครบแล้ว (ฉบับตามกล้อง)' : 'Footage พร้อม'
      const at = new Date(n.at.getTime() + 7 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')
      // once per booking for the whole watch window (alertOps' throttle stamp; it also keeps a permanent audit row)
      await alertOps(`ready-fast-more:${code}`, `ไฟล์มาเพิ่มหลังแจ้ง ${what} (ทางลัด MEDIAPRO) — ${code}`,
        `${code}: แจ้ง "${what}" ไปแล้ว ${at} น. ด้วยทางลัด MEDIAPRO (ไม่รอ 4 ชม.) แต่หลังจากนั้น${why}\n` +
        'แปลว่ายังมีการ์ดที่ตอนแจ้งยังไม่ขึ้น Drive — บอกทีมในใบนี้ว่าไฟล์ยังมาไม่หมด · ถ้าเกิดบ่อย เพิ่ม FOOTAGE_READY_VERIFIED_SETTLE_MS (หรือปิดทางลัดด้วยค่า ≥ SETTLE_MS)',
        FAST_WATCH_DAYS * DAY)
    }
  } catch (e: any) {
    result.errors.push({ code: 'fast-watch', error: e?.message || String(e) }) // loud: a broken watch must not look like "nothing arrived"
  }
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
  // v1.287 — ≥ settleMs turns the MEDIAPRO fast path off (the long settle is always reached first)
  const verifiedSettleMs = envInt('FOOTAGE_READY_VERIFIED_SETTLE_MS', 20 * 60_000)
  const maxPerRun = envInt('FOOTAGE_READY_MAX_PER_RUN', 5)
  const since = new Date(now.getTime() - lookbackDays * DAY)

  const result: FootageReadyScanResult = {
    dryRun, forced, audience, scanned: 0, eligible: 0, walked: 0, deferred: 0, deferredCodes: [],
    notified: [], settling: [], skipped: [], errors: [], followedUp: [], followUpWaiting: [], fast: [], fastMore: [], calendarMarked: [],
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
            OR: [
              { shootDate: { gte: since } }, { shootEndDate: { gte: since } },
              // v1.277 — a field card still moving (pass 2 can come days later) keeps its booking in view
              { uploads: { some: { fileName: { startsWith: CARD_PREFIX }, updatedAt: { gte: since } } } },
            ],
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
      // v1.277 — field cards are governed by ingestHeld below; a ticket nobody ran (PENDING) holds nothing
      NOT: { fileName: { startsWith: CARD_PREFIX } },
    },
    _count: true,
  })
  const uploading = new Set(freshInFlight.map(u => u.bookingId))

  // v1.277 — field-ingest cards: hold with no expiry; flip the silent ones to ORPHANED and say so.
  // The stale scan covers EVERY open card (a second camera's card on a booking already notified must still
  // alert when its laptop dies); the hold applies to this sweep's candidates. dryRun holds the same, flips nothing.
  const cardRows = await prisma.upload.findMany({
    where: { fileName: { startsWith: CARD_PREFIX }, status: { in: ['UPLOADING', 'ORPHANED'] } },
    select: { id: true, bookingId: true, fileName: true, status: true, updatedAt: true, notes: true, uploadedBy: true, camera: true,
      booking: { select: { bookingCode: true } } },
  })
  const ingestHeld = new Set(cardRows.filter(r => cardHoldsNotice([r])).map(r => r.bookingId))
  if (!dryRun) {
    for (const r of cardRows.filter(r => isStaleCard(r, now))) {
      const code = r.booking?.bookingCode || r.bookingId
      const silentMin = Math.round((now.getTime() - r.updatedAt.getTime()) / 60_000)
      await prisma.upload.update({ where: { id: r.id }, data: { status: 'ORPHANED', failureReason: `ไม่มีสัญญาณจากเครื่องที่ส่ง ${silentMin} นาที` } })
        .catch(e => console.error('[footage-ready] orphan card failed:', r.id, e?.message || e))
      await alertOps(`ingest-stale:${code}`, `⚠️ ส่งจากหน้างาน ${code} ${r.camera} เงียบ ${silentMin} นาที`,
        `การ์ด ${r.fileName} โดย ${r.uploadedBy} ไม่ส่งสัญญาณมา ${silentMin} นาที (เครื่องหลับ/เน็ตหลุด/ปิดแอป?) → ORPHANED\n` +
        'footage พร้อม ของใบนี้ถูกถือไว้ · รันไคลเอนต์ซ้ำด้วยโค้ดเดิมจะส่งต่อได้ · ปล่อยด้วยมือ = แอดมินกด "ปลด" ที่การ์ดบนหน้าอัป (ไม่ลบไฟล์)')
    }
  }

  // Gate (d): NAS queue state, one read for the whole sweep.
  // v1.262.1 — only while the NAS picture is fresh: a dead Mac agent leaves its last "still sending"
  // forever, which held a booking's notice silently (review of v1.262). Stale = gate off; the operator
  // hears about the silent scanner from the relay instead.
  const nasState = await latestNasState().catch(() => ({ manifest: null, statuses: {} as Record<string, any> }))
  const nasStatuses = nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale ? (nasState.statuses || {}) : {}
  // v1.287 — the fast path leans on gate (d): it needs a NAS scan taken AFTER the first look at these counts (a card
  // landing on the NAS since then would show as pending). Agent silent → gate (d) is off → the long settle only.
  const nasSeenAt = nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale ? Date.parse(nasState.manifest.at) : NaN

  const eligible: CandidateRow[] = []
  for (const b of rows) {
    const code = b.bookingCode as string
    // callTime — an overnight single-day shoot (wrap ≤ call) is not over on its own shoot day's morning
    if (!isShootOver({ shootDate: b.shootDate, shootEndDate: b.shootEndDate, estimatedWrap: b.estimatedWrap, callTime: b.callTime }, now)) {
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
    if (ingestHeld.has(b.id)) {
      result.skipped.push({ code, reason: 'ingest-pending' }); continue
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
  // what was NOT walked — a forced run walks all of them, so it defers none (it used to name walked codes as deferred)
  result.deferredCodes = ordered.slice(toWalk.length).map(r => r.bookingCode as string)

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
      const counts = { fileCount: payload.fileCount, totalBytes: payload.folders.reduce((n, f) => n + f.totalBytes, 0) }
      const snapshot = parseReadySnapshot(b.readySnapshot)
      const decision = forced.length > 0 ? { settled: true, write: null } : evaluateSettle(counts, snapshot, now, settleMs)
      let gate: GateResult | null = null
      let readyPath: 'forced' | 'settle' | 'mediapro' = forced.length > 0 ? 'forced' : 'settle'
      if (!decision.settled) {
        // v1.287 — MEDIAPRO fast path. Only once these exact counts were already seen by an earlier walk at least
        // verifiedSettleMs ago (one sweep): a card still being copied grows the counts or shows up on the NAS
        // scan (~10 min) in between. At most ONE gate per walk either way, so a sweep costs no more than before.
        if (!decision.write && snapshot && evaluateSettle(counts, snapshot, now, verifiedSettleMs).settled) {
          const known = readFastNo(b.readySnapshot, counts)
          if (known) result.fast.push({ code, ok: false, detail: known, cached: true })
          else if (!(nasSeenAt > Date.parse(snapshot.at))) {
            // not remembered: the scanner coming back changes the answer without the footage changing
            result.fast.push({ code, ok: false, detail: 'ตัวสแกน NAS ไม่ได้รายงานหลังเห็นไฟล์ชุดนี้ — ไม่รู้ว่ายังมีการ์ดค้างส่งไหม', cached: false })
          } else {
            const g = await mediaproGateFor(b, code)
            const why = fastPathBlocker(g, b)
            result.fast.push({ code, ok: !why, detail: why || g!.text, cached: false })
            if (!why) { gate = g; readyPath = 'mediapro' }
            // only a comparison that RAN is remembered (same rule as noteHeld): "could not check" retries next sweep
            else if (!dryRun && g?.check) await noteFastNo(b, code, why, counts, now)
          }
        }
        if (!gate) {
          result.settling.push(code)
          if (!dryRun && decision.write) {
            await prisma.booking.update({ where: { id: b.id }, data: { readySnapshot: decision.write } }).catch(() => {})
          }
          continue
        }
      }

      // Gate (g) — every file the cards' MEDIAPRO.XML lists must be in place (mediaproGateFor). Runs in
      // dry-run too (read-only), so a preview says exactly what the sweep would do. The fast path above
      // already ran it (and passed) — never twice in one walk.
      if (!gate) {
        gate = await mediaproGateFor(b, code)
        if (!gate) {
          result.skipped.push({ code, reason: 'mediapro-incomplete', detail: 'ตรวจกล่องไม่ได้ (Drive) — รอรอบหน้า' })
          continue
        }
      }
      if (!gate.ok) {
        result.skipped.push({ code, reason: 'mediapro-incomplete', detail: gate.text })
        // v1.274 — remember WHY, so the health check and the 📣 preview can say "files missing"
        // after this booking ages out of the window (re-running this gate costs minutes of Drive walks)
        // only a comparison that ran is evidence of missing files; check:null = "could not check" — keep any earlier verdict
        if (!dryRun && gate.check) await noteHeld(b, code, gate.text, counts.fileCount, counts.totalBytes, now)
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
        // v1.288 — and its event would get ✅ (the calendar pass reads stamped bookings, which a dry run never makes) —
        // only on an unattended sweep: a ?codes= run does not run that pass (the next sweep marks it)
        if (b.calendarEventId && forced.length === 0) result.calendarMarked.push(code)
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
          ...(sent.failedRecipients.length ? { failedRecipients: sent.failedRecipients } : {}),
          ...(sent.skippedInactive.length ? { skippedInactive: sent.skippedInactive } : {}),
          folderCount: payload.folders.length,
          fileCount: payload.fileCount,
          mediapro: verified,
          readyPath, // v1.287 — 'mediapro' = sent on MEDIAPRO's word, without the long settle
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
      await notifyPartialMail(code, 'Footage พร้อม', sent.failedRecipients, sent.error)
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
  const verifiedSettleMs = envInt('FOOTAGE_READY_VERIFIED_SETTLE_MS', 20 * 60_000) // v1.287 — same rule as the first notice
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
          where: { bookingId: b.id, status: { in: ['PENDING', 'UPLOADING'] }, updatedAt: { gte: new Date(now.getTime() - DAY) },
            NOT: { fileName: { startsWith: CARD_PREFIX } } },
        })
        if (inFlight > 0) { wait('ยังอัปโหลดอยู่'); continue }
        // v1.277 — same hold as the first notice: an open or dead field card is not "arrived"
        const openCards = await prisma.upload.count({ where: { bookingId: b.id, fileName: { startsWith: CARD_PREFIX }, status: { in: ['UPLOADING', 'ORPHANED'] } } })
        if (openCards > 0) { wait('ส่งจากหน้างานยังไม่ครบ'); continue }
        if ((nasStatuses[code]?.lastPending || 0) > 0) { wait('NAS ยังส่งไม่หมด'); continue }
        const gate = await mediaproGateFor(b, code)
        if (!gate) { wait('ตรวจกล่องไม่ได้ (Drive)'); continue }
        if (!gate.ok) { wait(gate.text); continue }
        const cov = cameraCoverage(gate.files || [], b, gate.check?.twinCopies)
        if (cov.gap) { wait(cov.gap); continue }
        // "the cameras arrived" must be TRUE, not "the rule went quiet" (review): countable, and more cameras than at the notice
        if (cov.uncounted) { wait('นับกล้องไม่ได้ (มีภาพอยู่นอกโฟลเดอร์ CAM-x) — ไม่ส่งฉบับ "กล้องครบ"'); continue }
        if (cov.cams.length <= first.cams) { wait(`ไม่มีกล้องใหม่ขึ้นมา (${cov.cams.length} กล้องเท่าตอนแจ้ง) — จำนวนกล้องในใบอาจถูกแก้`); continue }
        // v1.287 — MEDIAPRO vouches for the whole box (and the NAS scanner is alive) → the short wait, as for the first
        // notice · min: the kill switch (VERIFIED >= SETTLE) must give back the old wait, never a longer one
        // review r2 — like the first notice: the NAS must have reported AFTER the newest file arrived
        const newest = newestFileAt((gate.files || []).filter(isFootageFile))
        const nasAfter = !!nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale && Date.parse(nasState.manifest.at) > newest
        const short = nasAfter && !fastPathBlocker(gate, b)
        const quiet = short ? Math.min(verifiedSettleMs, settleMs) : settleMs
        if (now.getTime() - newest < quiet) { wait('ไฟล์ยังทยอยเข้า — รอให้นิ่ง'); continue }
        if (result.dryRun) { result.followedUp.push(code); continue }
        const sent = await sendCameraFollowUp(b, w, cov, gate.text, gate.files?.length || 0)
        if (!sent.delivered) { result.errors.push({ code, error: `follow-up: ${sent.error || 'no channel'}` }); continue } // retried next sweep
        followUpSent.add(w.entityId!)
        result.followedUp.push(code)
        await notifyPartialMail(code, 'Footage ครบแล้ว', sent.failedRecipients, sent.error)
        try {
          // awaited + throwing (not logAudit, which swallows): this row is the send-once record
          await prisma.auditLog.create({
            data: {
              actorEmail: 'footage-ready-worker', action: 'booking.ready_followup', entityType: 'Booking', entityId: b.id, bookingCode: code,
              changes: JSON.parse(JSON.stringify({
                audience: result.audience, recipients: sent.recipients,
                ...(sent.failedRecipients.length ? { failedRecipients: sent.failedRecipients } : {}),
                ...(sent.skippedInactive.length ? { skippedInactive: sent.skippedInactive } : {}),
                cameraGapBefore: first.gap, cams: cov.cams, fileCount: gate.files?.length || 0, mediapro: gate.text,
                readyPath: short && quiet < settleMs ? 'mediapro' : 'settle', // v1.287 — watchFastNotices watches the short ones
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
): Promise<{ delivered: boolean; recipients: string[]; failedRecipients: string[]; skippedInactive: string[]; operatorChannels: { digestOk: boolean; discordOk: boolean; larkOk: boolean }; error: string | null }> {
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
  let mail: MailEachResult = { sent: [], failed: [] }
  let error: string | null = null
  if (people.length && isEmailConfigured()) {
    mail = await emailEach(people, subject, text)
    if (mail.failed.length) error = `${mail.failed.length}/${people.length} ส่งไม่สำเร็จ`
  } else if (!people.length) error = 'ไม่มีคนในทีมให้แจ้ง'
  else error = 'email not configured'
  const emailed = mail.sent.length
  const digestOk = digest || !people.length ? await notifyEmailDigest(subject, text) : false
  const { discord: discordOk, lark: larkOk, any: chatOk } = await notifyChatDetailed(`✅ กล้องตามมาครบ: ${code} — ${show} (${cov.cams.join(', ') || 'ไฟล์ภาพครบ'}) → ${emailed}/${people.length} อีเมล`)
  return {
    delivered: emailed > 0 || (!isEmailConfigured() && chatOk) || (people.length === 0 && (digestOk || chatOk)),
    // maint 2026-11-08 — only the addresses the provider accepted (see emailEach)
    recipients: digestOk ? [...mail.sent, ADMIN_DIGEST] : mail.sent,
    failedRecipients: mail.failed,
    skippedInactive: inactive,
    operatorChannels: { digestOk, discordOk, larkOk },
    error,
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

type MailEachResult = { sent: string[]; failed: string[] }

/**
 * maint 2026-11-08 — one mail per person, split by what the provider ACCEPTED (class 1 "a record is not delivery",
 * per person). The audit used to record every INTENDED address while `emailed` counted only the fulfilled sends: one
 * success stamped readyNotifiedAt (send-once), /stats counted the people whose mail hit an SMTP 421/timeout as reached,
 * and nobody ever re-sent to them. Now they are named (`failedRecipients`) and ops is told (notifyPartialMail).
 */
async function emailEach(people: string[], subject: string, text: string): Promise<MailEachResult> {
  const results = await Promise.allSettled(people.map(to => sendEmail({ to: [to], subject, text })))
  return {
    sent: people.filter((_, i) => results[i].status === 'fulfilled'),
    failed: people.filter((_, i) => results[i].status === 'rejected'),
  }
}

/**
 * The booking is stamped (send-once) because at least one person on the job heard; the ones who did not are NOT retried
 * automatically (a re-send needs per-person state this table does not have) — so a human must hear who, now.
 * ponytail: ops alert + audit field, no auto re-send; add a per-recipient retry if partial failures turn out common.
 */
async function notifyPartialMail(code: string, what: string, failed: string[], error: string | null): Promise<void> {
  if (!failed.length) return
  console.error(`[footage-ready] ${code}: ${what} ส่งไม่ถึง ${failed.length} คน: ${failed.join(', ')}`)
  await alertOps(`ready-mail-partial:${code}`, `เมล ${what} ส่งไม่ถึงบางคน — ${code}`,
    `${code}: เมล "${what}" ส่งไม่ถึง ${failed.join(', ')} (${error || 'ส่งไม่สำเร็จ'})\n` +
    'คนอื่นในใบได้รับแล้ว ใบนี้จึงถูกบันทึกว่าแจ้งแล้ว และระบบจะไม่ส่งซ้ำเอง — ส่งต่อให้คนที่ตกหล่นด้วยมือ')
}

async function sendFootageReadyNotification(
  b: CandidateRow,
  payload: FootagePayload,
  audience: FootageReadyAudience,
  verified: string,
  inactiveEmails: string[],
): Promise<{
  delivered: boolean
  /** maint 2026-11-08 — addresses the mail provider ACCEPTED (+ ADMIN_DIGEST when that went through) — not the intent */
  recipients: string[]
  /** maint 2026-11-08 — addresses whose mail was rejected/timed out: recorded + told to ops, never counted as reached */
  failedRecipients: string[]
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
      failedRecipients: [],
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
      failedRecipients: [],
      skippedInactive,
      operatorChannels: { digestOk: warned, discordOk, larkOk },
      error: skippedInactive.length ? 'all team members inactive' : 'no producer email',
    }
  }

  let mail: MailEachResult = { sent: [], failed: [] }
  let error: string | null = null
  if (isEmailConfigured()) {
    // One email PER recipient — assignedEmails can include external freelancers'
    // personal addresses (same privacy rule as the manual notify-ready).
    mail = await emailEach(recipients, subject, text)
    if (mail.failed.length) error = `${mail.failed.length}/${recipients.length} ส่งไม่สำเร็จ`
  } else {
    error = 'email not configured'
  }
  const emailed = mail.sent.length
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
    // maint 2026-11-08 — and only the people whose mail the provider accepted (see emailEach)
    recipients: digestOk ? [...mail.sent, ADMIN_DIGEST] : mail.sent,
    failedRecipients: mail.failed,
    skippedInactive,
    operatorChannels: { digestOk, discordOk, larkOk },
    error,
  }
}
