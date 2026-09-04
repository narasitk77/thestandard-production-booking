// v1.215 — คิวงานมิกซ์เสียง: กฎล้วน ๆ ไม่มี prisma ไม่มี fetch
//
// แยกออกมาเป็นโมดูลบริสุทธิ์ด้วยเหตุผลเดียวกับ switcher-jobs.ts — กฎ "ใครแก้อะไร
// ได้" คือส่วนที่ผิดแล้วเจ็บที่สุดและมองไม่เห็นจากตาแอดมิน (บทเรียน v1.196: โปรดิวเซอร์
// มองไม่เห็นงานตัวเอง 59 ใบ เพราะกฎการมองเห็นกระจายอยู่หลายที่) กฎอยู่ที่นี่ที่เดียว
// route เป็นแค่เปลือก HTTP
//
// ─── ทำไมคิวนี้ถึงกลับด้านกับ SwitcherJob ───────────────────────────────────────
// SwitcherJob = สมุดบันทึกของคนทำ · MixJob = คิวของคนขอ
// คนกรอกใน log คือคนที่ทำเสร็จแล้ว (ไม่ได้อะไรจากการกรอก) · คนกรอกในคิวคือคนที่
// อยากได้ของ (ไม่กรอกแล้วไม่ได้งาน) — ความต่างนี้คือเหตุผลที่ switcher_jobs มี 0 แถว
// ส่วน bookings มี 532 แถว วัดเมื่อ 2026-09-03

export const MIX_STATUSES = ['QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const
export type MixStatus = (typeof MIX_STATUSES)[number]

export const MIX_STATUS_LABEL: Record<MixStatus, string> = {
  QUEUED: 'รอคิว',
  IN_PROGRESS: 'กำลังมิกซ์',
  DONE: 'ส่งแล้ว',
  CANCELLED: 'ยกเลิก',
}

/** สถานะที่ถือว่างานยังเดินอยู่ — ใช้ทั้งตอนนับคิวและตอนกันสร้างซ้ำ */
export const OPEN_MIX_STATUSES: readonly MixStatus[] = ['QUEUED', 'IN_PROGRESS']

export function isMixStatus(v: unknown): v is MixStatus {
  return typeof v === 'string' && (MIX_STATUSES as readonly string[]).includes(v)
}

export interface MixJobLike {
  status?: string | null
  deliveryLink?: string | null
  requesterEmail?: string | null
  assigneeEmail?: string | null
  dueDate?: Date | string | null
  deliveredAt?: Date | string | null
  deletedAt?: Date | string | null
}

export interface MixActor {
  email: string
  /** ทีมเสียง — เปลี่ยนสถานะงานได้ และหยิบงานที่ยังไม่มีเจ้าของได้ */
  isSound: boolean
  /** v1.216 — coordinator ของทีมเสียง (ค่าเริ่มต้น krittapon.j@) — **แจกงานให้คนอื่นได้** */
  isCoordinator: boolean
  /** ADMIN / MANAGER — ทำได้ทุกอย่างกับทุกแถว */
  canEditAll: boolean
}

/* ───────────────────────────── เลขที่อ้างถึงกันได้ ───────────────────────────── */

/** 7 → "MIX-007" · เลขเกิน 3 หลักก็ยังอ่านได้ ไม่ตัดทิ้ง */
export function formatMixNumber(n: number): string {
  return `MIX-${String(n).padStart(3, '0')}`
}

/* ──────────────────────────────── การเปลี่ยนสถานะ ─────────────────────────────── */

/**
 * เปลี่ยนสถานะจาก → ไป ได้ไหม
 *
 * เป็น allowlist ไม่ใช่ denylist: สถานะใหม่ที่เพิ่มวันหลังจะ "ไปไหนไม่ได้" จนกว่า
 * จะมีคนเขียนกฎให้ ซึ่งปลอดภัยกว่าการปล่อยผ่านโดยไม่ตั้งใจ
 *
 * DONE กลับไป IN_PROGRESS ได้ (ส่งแล้วลูกค้าขอแก้ = เรื่องปกติของงานมิกซ์)
 * CANCELLED กลับมา QUEUED ได้ (ยกเลิกผิด/งานกลับมา) — แต่ต้องผ่านคิวใหม่
 */
const ALLOWED_TRANSITIONS: Record<MixStatus, readonly MixStatus[]> = {
  QUEUED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'QUEUED', 'CANCELLED'],
  DONE: ['IN_PROGRESS'],
  CANCELLED: ['QUEUED'],
}

export function canTransition(from: string | null | undefined, to: MixStatus): boolean {
  const cur = (from || 'QUEUED') as MixStatus
  if (!isMixStatus(cur)) return false
  if (cur === to) return true
  return (ALLOWED_TRANSITIONS[cur] || []).includes(to)
}

/* ─────────────────────────────────── สิทธิ์ ──────────────────────────────────── */

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/**
 * แก้เนื้องาน (ชื่อ ลิงก์ กำหนดส่ง โน้ต) ได้ไหม
 *
 * คนขอแก้ของตัวเองได้ **เฉพาะตอนยังไม่มีใครรับ** — พอทีมเสียงเริ่มทำแล้ว การแก้
 * โจทย์กลางคันคือการเปลี่ยนงานที่คนอื่นลงแรงไปแล้วโดยเขาไม่รู้ตัว ถ้าจำเป็นจริง
 * ให้คุยกันแล้วให้คนที่รับงานหรือแอดมินเป็นคนแก้
 */
export function canEditMixJob(actor: MixActor, job: MixJobLike): boolean {
  if (actor.canEditAll) return true
  if (sameEmail(job.assigneeEmail, actor.email)) return true
  if (sameEmail(job.requesterEmail, actor.email)) return (job.status || 'QUEUED') === 'QUEUED'
  return false
}

/**
 * "หยิบงานเอง" ได้ไหม — เฉพาะทีมเสียง และเฉพาะแถวที่ยังไม่มีเจ้าของ
 *
 * v1.216: กระบวนการหลักคือ **coordinator แจก** (ดู canAssignMixJob) — ตัวนี้เป็น
 * ทางสำรองไว้ตอน coordinator ไม่อยู่ ไม่งั้นคิวจะค้างทั้งคิวเพราะคนเดียวลาหยุด
 * ซึ่งเป็น single point of failure ที่ไม่คุ้มกับความเรียบร้อยของกระบวนการ
 *
 * ตั้งใจไม่ให้คนขอหยิบงานของตัวเอง: ถ้าใครก็ตั้งตัวเองเป็นคนมิกซ์ได้
 * ตัวเลขภาระงานของทีมเสียงจะเชื่อไม่ได้
 */
export function canClaimMixJob(actor: MixActor, job: MixJobLike): boolean {
  if (job.assigneeEmail) return false
  if ((job.status || 'QUEUED') === 'CANCELLED') return false
  return actor.isSound || actor.canEditAll
}

/**
 * v1.216 — **แจกงานให้คนอื่น** ได้ไหม · นี่คือเส้นทางหลักที่ operator ออกแบบไว้:
 * คำขอเข้ามา → coordinator ได้รับแจ้ง → coordinator แจกให้ทีมงาน
 *
 * ต่างจาก canClaimMixJob ตรงที่ตัวนั้นคือ "หยิบให้ตัวเอง" ส่วนตัวนี้คือ "สั่งให้คนอื่นทำ"
 * ซึ่งเป็นอำนาจคนละระดับ — จึงจำกัดไว้ที่ coordinator กับ admin เท่านั้น
 *
 * แจกซ้ำได้ (เปลี่ยนตัวคนทำ) ตราบใดที่งานยังไม่จบ — คนป่วย งานด่วนแทรก เป็นเรื่องปกติ
 */
export function canAssignMixJob(actor: MixActor, job: MixJobLike): boolean {
  const status = (job.status || 'QUEUED') as MixStatus
  if (status === 'DONE' || status === 'CANCELLED') return false
  return actor.isCoordinator || actor.canEditAll
}

/**
 * คนที่จะถูกแจกงานได้ ต้องอยู่ในทีมเสียงจริง
 *
 * เช็คที่นี่ไม่ใช่ที่ route เพราะ "แจกงานให้คนที่ไม่ใช่ทีมเสียง" ทำให้ตัวเลขภาระงาน
 * เพี้ยนแบบเดียวกับการให้คนขอหยิบงานเอง · ส่งรายชื่อ roster เข้ามาแทนที่จะไปอ่าน DB
 * เองเพื่อให้ฟังก์ชันนี้ยังเทสได้โดยไม่ต้องมีฐานข้อมูล
 */
export function isAssignableTo(email: string, soundRoster: readonly string[]): boolean {
  const lower = email.trim().toLowerCase()
  if (!lower) return false
  return soundRoster.some(r => r.trim().toLowerCase() === lower)
}

/**
 * v1.217 — ลิงก์ที่ยอมรับได้: http/https เท่านั้น
 *
 * แยกออกมาเพราะใช้ทั้งขาเข้า (sourceLink) และขาออก (deliveryLink) และการปล่อยให้
 * `javascript:` หรือ `file://` ผ่านคือช่องที่คนคลิกจากในระบบแล้วเจอของที่ไม่คาดคิด
 */
export function normalizeHttpLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return s
  } catch {
    return null
  }
}

/**
 * v1.217 — ปิดงานเป็น DONE ได้ก็ต่อเมื่อ **บอกแล้วว่าไฟล์อยู่ไหน**
 *
 * ไม่ใช่การขัดขวาง: คิวนี้มีไว้ให้คนขอเลิกเดินไปถามในแชท ถ้ากด "ส่งแล้ว" ได้โดย
 * ไม่มีลิงก์ คนขอจะได้เมลว่าเสร็จแล้วแต่ไม่รู้ว่าไฟล์อยู่ไหน แล้วก็กลับไปถามอยู่ดี
 * = วงจรไม่ปิด รูปเดียวกับกฎ "ต้องมีใบจองหรือ sourceLink อย่างน้อยหนึ่ง" ขาเข้า
 *
 * ราคาที่ต้องรู้: ถ้าคนไม่มีลิงก์จริง ๆ เขาอาจเลี่ยงด้วยการไม่กดปิดงานเลย ซึ่งแย่กว่า
 * — ถ้าวันหนึ่งคิวเต็มไปด้วยงานที่ทำเสร็จแล้วแต่ค้างสถานะ ให้ผ่อนกฎนี้
 */
export function canCloseMixJob(job: MixJobLike, incomingLink?: unknown): boolean {
  return !!(normalizeHttpLink(incomingLink) || normalizeHttpLink(job.deliveryLink))
}

/** เปลี่ยนสถานะได้ไหม — คนขอ "ยกเลิกงานตัวเอง" ได้ นอกนั้นเป็นเรื่องของทีมเสียง */
export function canSetMixStatus(actor: MixActor, job: MixJobLike, next: MixStatus): boolean {
  if (!canTransition(job.status, next)) return false
  if (actor.canEditAll) return true
  if (actor.isSound) return true
  if (sameEmail(job.requesterEmail, actor.email)) {
    return next === 'CANCELLED' && (job.status || 'QUEUED') === 'QUEUED'
  }
  return false
}

/* ─────────────────────────────── สภาพของคิว ─────────────────────────────────── */

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export type MixFlag = 'OVERDUE' | 'DUE_SOON' | 'UNCLAIMED' | null

/**
 * ธงเตือนของแถวนี้ เรียงตามความแรง
 *
 * งานที่ส่งแล้ว/ยกเลิกไม่มีธง — ธงมีไว้ให้คนมองหาสิ่งที่ต้องลงมือ ไม่ใช่ประดับ
 * `today` รับเข้ามาเพื่อให้เทสได้โดยไม่ต้องแกล้งเวลาเครื่อง
 */
export function mixFlag(job: MixJobLike, today: Date = new Date()): MixFlag {
  const status = (job.status || 'QUEUED') as MixStatus
  if (status === 'DONE' || status === 'CANCELLED') return null
  const due = toDate(job.dueDate)
  if (due) {
    const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate())
    if (dueDay < startOfToday) return 'OVERDUE'
    if (dueDay - startOfToday <= 2 * 86_400_000) return 'DUE_SOON'
  }
  if (!job.assigneeEmail) return 'UNCLAIMED'
  return null
}

export const MIX_FLAG_LABEL: Record<Exclude<MixFlag, null>, string> = {
  OVERDUE: 'เลยกำหนดส่ง',
  DUE_SOON: 'ใกล้กำหนด',
  UNCLAIMED: 'ยังไม่มีคนรับ',
}

/** ส่งทันกำหนดไหม — null เมื่อยังไม่ส่ง หรือไม่ได้ตั้งกำหนด (ไม่ใช่ "ไม่ทัน") */
export function deliveredOnTime(job: MixJobLike): boolean | null {
  const delivered = toDate(job.deliveredAt)
  const due = toDate(job.dueDate)
  if (!delivered || !due) return null
  const dDay = Date.UTC(delivered.getUTCFullYear(), delivered.getUTCMonth(), delivered.getUTCDate())
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate())
  return dDay <= dueDay
}

/* ──────────────────────────────── การตรวจข้อมูล ─────────────────────────────── */

export interface MixJobInput {
  title?: unknown
  bookingId?: unknown
  dueDate?: unknown
  sourceLink?: unknown
  notes?: unknown
}

export interface CleanMixJob {
  title: string
  bookingId: string | null
  dueDate: string | null
  sourceLink: string | null
  notes: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * ตรวจ + ทำความสะอาดของที่คนกรอกมา
 *
 * ตั้งใจ **ไม่บังคับ** ให้มีทั้ง bookingId และ sourceLink พร้อมกัน: งานที่ต่อจากกอง
 * หาไฟล์จากใบจองได้เอง ส่วนงานเดี่ยวต้องมีลิงก์ — บังคับทั้งคู่จะทำให้กลุ่มใดกลุ่ม
 * หนึ่งกรอกไม่ผ่าน แต่ถ้าไม่มีสักอย่างเลย ทีมเสียงจะไม่รู้ว่าไฟล์อยู่ไหน จึงบังคับ
 * ว่าต้องมีอย่างน้อยหนึ่งอย่าง
 */
export function validateMixJob(input: MixJobInput): { ok: true; value: CleanMixJob } | { ok: false; error: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'ต้องใส่ชื่องานที่จะมิกซ์' }
  if (title.length > 200) return { ok: false, error: 'ชื่องานยาวเกิน 200 ตัวอักษร' }

  const bookingId = typeof input.bookingId === 'string' && input.bookingId.trim() ? input.bookingId.trim() : null

  let dueDate: string | null = null
  if (input.dueDate !== undefined && input.dueDate !== null && input.dueDate !== '') {
    if (!isValidISODate(input.dueDate)) return { ok: false, error: 'กำหนดส่งต้องเป็นรูปแบบ YYYY-MM-DD' }
    dueDate = input.dueDate
  }

  let sourceLink: string | null = null
  if (typeof input.sourceLink === 'string' && input.sourceLink.trim()) {
    const raw = input.sourceLink.trim()
    try {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      sourceLink = raw
    } catch {
      return { ok: false, error: 'ลิงก์ไฟล์ต้องขึ้นต้นด้วย http:// หรือ https://' }
    }
  }

  if (!bookingId && !sourceLink) {
    return { ok: false, error: 'ต้องผูกใบจอง หรือใส่ลิงก์ไฟล์อย่างน้อยหนึ่งอย่าง ไม่งั้นทีมเสียงไม่รู้ว่าไฟล์อยู่ไหน' }
  }

  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 4000) : null
  return { ok: true, value: { title, bookingId, dueDate, sourceLink, notes } }
}

/* ────────────────────────────────── การเรียงคิว ─────────────────────────────── */

/**
 * ลำดับที่คิวควรแสดง: งานที่ยังเดินอยู่ก่อน · ในกลุ่มนั้นเรียงตามกำหนดส่ง
 * (ไม่มีกำหนดไปท้ายสุด) · เท่ากันแล้วเรียงตามเลขที่ = มาก่อนได้ก่อน
 */
export function compareMixQueue(
  a: MixJobLike & { number?: number },
  b: MixJobLike & { number?: number },
): number {
  const open = (j: MixJobLike) => (OPEN_MIX_STATUSES as readonly string[]).includes(j.status || 'QUEUED') ? 0 : 1
  const byOpen = open(a) - open(b)
  if (byOpen !== 0) return byOpen

  const da = toDate(a.dueDate)
  const db = toDate(b.dueDate)
  if (da && db && da.getTime() !== db.getTime()) return da.getTime() - db.getTime()
  if (da && !db) return -1
  if (!da && db) return 1

  return (a.number ?? 0) - (b.number ?? 0)
}
