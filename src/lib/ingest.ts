/**
 * v1.277 — field ingest ("ส่งฟุตเทจจากหน้างาน"): the pure rules behind
 * /api/upload/ingest. rclone on the crew's own laptop is the muscle; this file
 * is the part of the brain that needs no database, so it can be tested without
 * one. Everything that touches Prisma or Drive stays in the route.
 *
 * One Upload row = one CARD (not one file). fileName `CARD_<CAM>_<YYMMDD>_<tail>`
 * is the only marker — no new columns, no new env. The ticket the client holds
 * is random; the row stores only its sha256, so a leaked DB dump cannot upload.
 *
 * Why the notice must hold without an expiry: footage-ready gate (c) releases a
 * browser upload after 24 h of silence (an abandoned tab). A card run can
 * legitimately be parked for days ("proxies ส่งแล้ว ต้นฉบับทีหลัง") and a dead
 * laptop must never turn into "footage พร้อม" by timeout — that is the
 * fail-open the red-team flagged. CARD_ rows in UPLOADING or ORPHANED hold the
 * notice until a human (ADMIN → FAILED) or a passing `complete` releases it.
 */
import { createHash, randomBytes } from 'crypto'

export const CARD_PREFIX = 'CARD_'
/** no heartbeat for this long = the client is gone → ORPHANED + alert */
export const STALE_MS = 20 * 60_000
/** Drive's per-identity upload cap, minus headroom for the crew's other writes */
export const QUOTA_BYTES = 750 * 1e9
export const QUOTA_MARGIN_BYTES = 20 * 1e9
/** phases where silence is intended, not a dead client */
export const PARKED_PHASES = new Set(['proxies-ok', 'quota-wait'])
/** what a heartbeat may report — parking goes through `pause`, closing through `complete`/`fail` */
export const HEARTBEAT_PHASES = new Set(['pass1', 'check1', 'pass2', 'check2'])

export type IngestPhase =
  | 'start' | 'pass1' | 'check1' | 'proxies-ok' | 'pass2' | 'check2' | 'quota-wait' | 'complete' | 'failed'

export interface IngestManifest {
  files: number      // files the client will send (after its excludes)
  bytes: number
  videos: number     // .mp4/.mxf/... incl. Sony Sub proxies
  wavs: number
  sonyTree: boolean  // XDROOT/ or M4ROOT/ present at the card root
  mediapro: boolean  // MEDIAPRO.XML present next to it
}

export interface IngestNotes {
  phase: IngestPhase
  bytes?: number     // bytes the client reports as sent so far (rclone stats, approximate)
  files?: number
  eta?: string
  at?: string
  manifest?: IngestManifest
  camFolderId?: string
  pathFromBox?: string
  announcedProxiesAt?: string
  check?: { matching: number; differences: number }
}

export function isCardRow(fileName: string | null | undefined): boolean {
  return typeof fileName === 'string' && fileName.startsWith(CARD_PREFIX)
}

/** CARD_CAM-A_261027_k3x9qz — camera, Bangkok date, tail of the Upload id (unique per row) */
export function cardFileName(camera: string, uploadId: string, now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit', day: '2-digit' })
    .format(now).replace(/-/g, '')
  return `${CARD_PREFIX}${camera.toUpperCase()}_${ymd}_${uploadId.slice(-6)}`
}

export function newTicket(): string {
  return randomBytes(32).toString('base64url')
}
export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex')
}

export function parseNotes(notes: string | null | undefined): IngestNotes | null {
  if (!notes) return null
  try {
    const v = JSON.parse(notes)
    return v && typeof v === 'object' && typeof v.phase === 'string' ? (v as IngestNotes) : null
  } catch { return null }
}

/** UPLOADING, not parked, and silent for STALE_MS → the client is gone. */
export function isStaleCard(row: { status: string; updatedAt: Date; notes: string | null }, now = new Date()): boolean {
  if (row.status !== 'UPLOADING') return false
  const phase = parseNotes(row.notes)?.phase
  if (phase && PARKED_PHASES.has(phase)) return false
  return now.getTime() - row.updatedAt.getTime() > STALE_MS
}

/** Any CARD_ row still open (or dead) holds the booking's "footage พร้อม". FAILED does not — that is the human release. */
export function cardHoldsNotice(rows: Array<{ fileName: string; status: string }>): boolean {
  return rows.some(r => isCardRow(r.fileName) && (r.status === 'UPLOADING' || r.status === 'ORPHANED'))
}

export function budgetBytes(usedBytes24h: number): number {
  return Math.max(0, QUOTA_BYTES - QUOTA_MARGIN_BYTES - Math.max(0, usedBytes24h))
}

export type Refusal = { ok: false; code: string; message: string }

export function decideStart(
  m: IngestManifest,
  ctx: {
    isAgency: boolean
    hasBox: boolean
    landingHasFiles: boolean
    nasPending: number
    otherUploaderInFlight: boolean
    usedBytes24h: number
  },
): { ok: true; budgetBytes: number } | Refusal {
  const no = (code: string, message: string): Refusal => ({ ok: false, code, message })
  if (ctx.isAgency) return no('AGN_PHASE3', 'ใบ AGN ยังไม่รองรับการส่งจากหน้างาน (Phase 3) — อัปผ่านหน้าเว็บหรือ NAS ไปก่อน')
  if (!ctx.hasBox) return no('NO_BOX', 'ใบนี้ยังไม่มีกล่องบน Drive ที่ระบบจำ id ไว้ — ให้แอดมินกดสร้างโฟลเดอร์ก่อน')
  if (m.videos + m.wavs === 0) return no('NO_MEDIA', 'ในโฟลเดอร์ที่เลือกไม่มีไฟล์วิดีโอหรือ WAV เลย — เลือกการ์ดผิดหรือยัง')
  if (!m.sonyTree) return no('NON_SONY', 'Phase 1 รับเฉพาะการ์ด Sony ทั้งใบ (มี XDROOT/ หรือ M4ROOT/) — กล้องอื่นอัปผ่านหน้าเว็บไปก่อน')
  if (!m.mediapro) return no('NO_MEDIAPRO', 'การ์ด Sony แต่ไม่มี MEDIAPRO.XML — ส่งทั้งการ์ด อย่าตัดโฟลเดอร์ออก')
  if (ctx.landingHasFiles) return no('LANDING_HAS_FILES', 'โฟลเดอร์ drop ของใบนี้มีไฟล์อยู่แล้ว (ส่งทาง NAS/Chrome) — ใบหนึ่งต้องส่งทางเดียว')
  if (ctx.nasPending > 0) return no('NAS_SENDING', `NAS ยังส่งไฟล์ของใบนี้อยู่ (${ctx.nasPending} ไฟล์) — ใบหนึ่งต้องส่งทางเดียว`)
  if (ctx.otherUploaderInFlight) return no('OTHER_UPLOADER', 'มีคนอื่นกำลังส่งการ์ดของใบนี้จากหน้างานอยู่ — รอให้เสร็จก่อน')
  const budget = budgetBytes(ctx.usedBytes24h)
  if (m.bytes > budget) {
    return no('QUOTA', `โควตาอัปของบัญชีคุณวันนี้เหลือ ${(budget / 1e9).toFixed(0)} GB แต่การ์ดมี ${(m.bytes / 1e9).toFixed(0)} GB — รอวันถัดไป หรือส่งเฉพาะ proxy`)
  }
  return { ok: true, budgetBytes: budget }
}

/**
 * `complete` is the only release. The client's `rclone check` proves "what the
 * source holds is on Drive"; the server re-reads the card folder itself and
 * refuses on anything the check cannot see: same-name twins (kill → rerun
 * within seconds made two identical JPGs and `check` said "ignoring") and a
 * count that does not match the manifest (a folder that vanished mid-run).
 */
export function decideComplete(
  check: { matching: number; differences: number },
  listing: { paths: string[] },
  manifestFiles: number,
): { ok: true } | Refusal {
  const no = (code: string, message: string): Refusal => ({ ok: false, code, message })
  if (!Number.isFinite(check.matching) || !Number.isFinite(check.differences)) return no('CHECK_MISSING', 'ไม่มีผล rclone check')
  if (check.differences > 0) return no('CHECK_FAILED', `rclone check พบไฟล์ไม่ตรง ${check.differences} ไฟล์`)
  if (check.matching === 0) return no('CHECK_EMPTY', 'rclone check ตรง 0 ไฟล์ — ไม่มีอะไรถูกส่ง')
  const seen = new Set<string>()
  const dups: string[] = []
  for (const p of listing.paths) { if (seen.has(p)) dups.push(p); else seen.add(p) }
  if (dups.length) return no('DUP_NAMES', `บน Drive มีไฟล์ชื่อซ้ำในโฟลเดอร์เดียวกัน ${dups.length} ไฟล์ (เช่น ${dups[0]}) — ต้องให้แอดมินดู`)
  if (listing.paths.length !== manifestFiles) {
    return no('COUNT_MISMATCH', `บน Drive มี ${listing.paths.length} ไฟล์ แต่การ์ดมี ${manifestFiles} ไฟล์`)
  }
  if (check.matching !== manifestFiles) {
    return no('COUNT_MISMATCH', `rclone check ตรง ${check.matching} ไฟล์ แต่การ์ดมี ${manifestFiles} ไฟล์`)
  }
  return { ok: true }
}
