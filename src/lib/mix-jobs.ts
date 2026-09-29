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

/**
 * v1.244 — ป้ายตามคำของ operator: Requested → Assigned → Completed (ชุดคำเดียวกับใบจองถ่าย)
 *
 * **เปลี่ยนแค่ป้าย ค่าที่เก็บยังเป็น QUEUED/IN_PROGRESS/DONE** โดยตั้งใจ: ความหมายตรงกันทุกตัว
 * (IN_PROGRESS เกิดตอนแจก/หยิบงานพอดี) การเปลี่ยนค่าที่เก็บ = migrate แถวเดิม + แก้ทุกที่ที่
 * เทียบสตริง เพื่อได้ผลที่คนเห็นเหมือนกันทุกประการ
 */
export const MIX_STATUS_LABEL: Record<MixStatus, string> = {
  QUEUED: 'Requested',
  IN_PROGRESS: 'Assigned',
  DONE: 'Completed',
  CANCELLED: 'Cancelled',
}

/** คำอธิบายภาษาไทยคู่ป้าย — ให้คนที่ไม่คุ้นคำอังกฤษรู้ว่าตอนนี้รออะไรอยู่ */
export const MIX_STATUS_HINT: Record<MixStatus, string> = {
  QUEUED: 'รอ Sound Admin แจกงาน',
  IN_PROGRESS: 'กำลังมิกซ์',
  DONE: 'ส่งไฟล์แล้ว',
  CANCELLED: 'ยกเลิกแล้ว',
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
 * v1.250 — **ลบคำขอ** ได้ไหม: แอดมินทุกแถว · คนขอเฉพาะคำขอของตัวเองที่ยังไม่มีคนรับ
 *
 * คำสั่ง operator 30 ก.ย. 2569 "จำกัดสิทธิ์ลบให้คนขอกับแอดมินเท่านั้น" · เดิมลบใช้กฎเดียวกับแก้งาน
 * (canEditMixJob) ซึ่งให้ **คนถืองาน** ลบได้ทุกสถานะ — ลบงานที่เลยกำหนดของตัวเองทิ้งได้ (ผู้ตรวจ v1.249 เจอ)
 * · แยกกฎเพราะ "แก้" กับ "ลบ" คนละเรื่อง: คนทำยังต้องแก้ลิงก์/โน้ตของงานที่ถืออยู่ได้ แต่ไม่ควรทำให้งานหายจากคิว
 * · Sound Admin ก็ลบไม่ได้ (ยกเลิกได้ตามเดิม) — งานที่ไม่ต้องทำแล้วให้ "ยกเลิก" ซึ่งยังเหลือร่องรอยในคิว
 */
export function canDeleteMixJob(actor: MixActor, job: MixJobLike): boolean {
  if (actor.canEditAll) return true
  return sameEmail(job.requesterEmail, actor.email) && (job.status || 'QUEUED') === 'QUEUED' && !job.assigneeEmail
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

/**
 * เปลี่ยนสถานะได้ไหม — คนขอ "ยกเลิกงานตัวเอง" ได้ นอกนั้นเป็นเรื่องของทีมเสียง
 *
 * v1.244 — **ส่งงาน (DONE) เฉพาะคนที่ถูกแจก** (+ coordinator/แอดมิน เป็นทางสำรอง) ตามที่
 * operator ระบุ "ผู้ที่ถูก assign เขามากด วางลิงก์และส่งงาน" · เดิมใครในทีมเสียงก็ปิดงาน
 * ของคนอื่นได้ ซึ่งทำให้ "ใครส่ง" ในเมลถึงคนขอไม่ใช่คนที่มิกซ์จริง
 */
export function canSetMixStatus(actor: MixActor, job: MixJobLike, next: MixStatus): boolean {
  if (!canTransition(job.status, next)) return false
  if (next === 'DONE' && (job.status || 'QUEUED') !== 'DONE') {
    return actor.canEditAll || actor.isCoordinator || sameEmail(job.assigneeEmail, actor.email)
  }
  if (actor.canEditAll) return true
  if (actor.isSound) return true
  if (sameEmail(job.requesterEmail, actor.email)) {
    return next === 'CANCELLED' && (job.status || 'QUEUED') === 'QUEUED'
  }
  return false
}

/**
 * v1.244 — แปะลิงก์ไฟล์ขาออกได้ไหม · route กับการ์ดใช้ตัวเดียวกัน
 *
 * ผู้ตรวจเจอว่าการ์ดโชว์ปุ่ม "ส่งงานแทน" ให้ Sound Admin (ตาม canSetMixStatus) แต่ route เช็คลิงก์ด้วย
 * canEditMixJob ซึ่งไม่รวม coordinator → กดแล้ว 403 ทุกครั้ง · กฎ = แก้งานได้ หรือกำลังส่งงานโดยคนที่ส่งได้
 */
export function canSetDeliveryLink(actor: MixActor, job: MixJobLike, nextStatus?: unknown): boolean {
  if (canEditMixJob(actor, job)) return true
  return nextStatus === 'DONE' && canSetMixStatus(actor, job, 'DONE')
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
// v1.244 — ค่าเริ่มต้นเป็น "วันนี้ตามเวลาไทย" · เดิม new Date() ถูกตัดเป็นวัน UTC ทำให้ช่วงตี 0–7
// ธงเลยกำหนดช้าไป 1 วัน (ผู้ตรวจเจอ) · เทสส่ง today เข้ามาเองเหมือนเดิม
export function mixFlag(job: MixJobLike, today: Date = new Date(`${bangkokDateKey()}T00:00:00Z`)): MixFlag {
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
  // deliveredAt เป็นเวลาจริง → วันไทย · dueDate เป็นวัน (@db.Date เที่ยงคืน UTC) → key ตรง ๆ
  return bangkokDateKey(delivered) <= due.toISOString().slice(0, 10)
}

/* ──────────────────────────────── การตรวจข้อมูล ─────────────────────────────── */

export interface MixJobInput {
  title?: unknown
  bookingId?: unknown
  /** v1.244 — แถว Episode (id ภายใน ไม่ใช่ EP ID) ที่ต้องการมิกซ์ ถ้าระบุตอน */
  episodeRowId?: unknown
  dueDate?: unknown
  sourceLink?: unknown
  notes?: unknown
}

export interface CleanMixJob {
  title: string
  bookingId: string | null
  episodeRowId: string | null
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
export function validateMixJob(
  input: MixJobInput,
  opts: { requireDueDate?: boolean } = {},
): { ok: true; value: CleanMixJob } | { ok: false; error: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'ต้องใส่ชื่องานที่จะมิกซ์' }
  if (title.length > 200) return { ok: false, error: 'ชื่องานยาวเกิน 200 ตัวอักษร' }

  const bookingId = typeof input.bookingId === 'string' && input.bookingId.trim() ? input.bookingId.trim() : null
  const episodeRowId = typeof input.episodeRowId === 'string' && input.episodeRowId.trim() ? input.episodeRowId.trim() : null
  // ตอนลอย ๆ ที่ไม่มีใบจองคือข้อมูลที่ตรวจไม่ได้ว่าตรงกับอะไร — route ต้องเช็คว่าตอนนี้อยู่ในใบนี้จริง
  if (episodeRowId && !bookingId) return { ok: false, error: 'ระบุตอนต้องระบุใบจองด้วย' }

  let dueDate: string | null = null
  if (input.dueDate !== undefined && input.dueDate !== null && input.dueDate !== '') {
    if (!isValidISODate(input.dueDate)) return { ok: false, error: 'กำหนดส่งต้องเป็นรูปแบบ YYYY-MM-DD' }
    dueDate = input.dueDate
  }
  // v1.244 — คำขอใหม่ต้องมีวันที่ต้องการไฟล์: ปฏิทินภาระงานเรียงจากวันนี้ งานไม่มีวันคืองาน
  // ที่ไม่มีใครเห็นในปฏิทิน · ตอนแก้ของเดิม (ก่อน v1.244 ไม่บังคับ) ไม่บังคับย้อนหลัง
  if (opts.requireDueDate && !dueDate) return { ok: false, error: 'ต้องเลือกวันที่ต้องการไฟล์' }

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
  return { ok: true, value: { title, bookingId, episodeRowId, dueDate, sourceLink, notes } }
}

/* ─────────────────────── v1.244 จับคู่ EP ID / Booking ID ─────────────────────── */

/**
 * ทำให้สิ่งที่คนพิมพ์/วางมาเทียบกับรหัสในระบบได้
 *
 * รหัสจริงเป็น ASCII ตัวใหญ่คั่นด้วย `-` (NWS-TSN-260702-01, PP-26-034-L01) แต่ของที่วาง
 * มาจากแชท/ชีทมักติด full-width, ขีดยาว (–—), ช่องว่าง หรือตัวเล็ก · NFKC แปลง full-width
 * กลับเป็น ASCII ก่อน แล้วค่อยแทนขีดทุกแบบด้วย `-`
 *
 * ช่องว่างกลางรหัส = ขีด ไม่ใช่ตัดทิ้ง: ทดสอบจริงพิมพ์ "pp-26-099 l01" แล้วได้ "PP-26-099L01" ซึ่งไม่ตรง
 * อะไรเลย · รหัสในระบบไม่มีช่องว่างสักตัว ช่องว่างจึงแปลว่าคนพิมพ์ขีดไม่ถึงเท่านั้น
 */
export function normalizeMixQuery(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .trim()
    .replace(/[\s-]*-[\s-]*|\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export interface MixTargetEpisode {
  id: string
  episodeId: string
  title?: string | null
  sequence?: number | null
}

export interface MixTargetBooking {
  id: string
  bookingCode: string | null
  status: string
  shootDate: Date | string
  deletedAt?: Date | string | null
  createdByEmail?: string | null
  producerEmail?: string | null
  coProducerEmail?: string | null
  assignedEmails?: string[] | null
  episodes: MixTargetEpisode[]
}

export interface MixTargetPick {
  bookingId: string
  /** null = ทั้งใบ (ยังไม่ได้ระบุตอน) */
  episodeRowId: string | null
}

export type MixResolution =
  | { kind: 'none'; reason: string }
  /** เจอแน่นอนหนึ่งเดียว · `needsEpisodePick` = ใบนี้มีหลายตอน ให้คนเลือกว่าตอนไหน (หรือทั้งใบ) */
  | { kind: 'match'; via: 'bookingCode' | 'bookingId' | 'episodeId'; pick: MixTargetPick; needsEpisodePick: boolean }
  /** EP ID เดียวอยู่หลายใบ (งาน AGN ที่ถ่ายตอนเดียวกันหลายวัน) — ห้ามเดา ต้องให้คนเลือก */
  | { kind: 'ambiguous'; options: MixTargetPick[] }

const involves = (b: MixTargetBooking, me: string) => {
  const m = me.trim().toLowerCase()
  const eq = (v?: string | null) => !!v && v.trim().toLowerCase() === m
  return !!m && (eq(b.createdByEmail) || eq(b.producerEmail) || eq(b.coProducerEmail)
    || (b.assignedEmails || []).some(eq))
}

const dayMs = (v: Date | string) => {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? Number.POSITIVE_INFINITY : d.getTime()
}

/**
 * จับคู่ของที่คนพิมพ์กับใบจอง/ตอน **จากรายการที่ route ดึงมาแล้ว** (ฟังก์ชันบริสุทธิ์ — เทสได้)
 *
 * ลำดับ: รหัสใบจอง/ไอดีภายใน → EP ID · เหตุผลที่รหัสใบจองมาก่อน: รหัสใบจองมักเท่ากับ EP ID
 * ของตอนแรกในใบเดียวกัน (NWS-TSN-260702-01 คือทั้งใบและตอนที่ 1) คนที่พิมพ์รหัสนี้ส่วนใหญ่
 * หมายถึงทั้งใบ — ถ้าใบมีหลายตอนจึงให้เลือกต่อ ไม่ใช่ผูกตอนที่ 1 ให้เงียบ ๆ
 *
 * **EP ID ไม่ unique** (ตรวจ prod 28 ก.ย.: 13/704 ID อยู่หลายใบ ทั้งหมดเป็น AGN หนักสุด 10 ใบ)
 * — เจอหลายใบ = ambiguous เสมอ เรียงให้ใบของคนขอขึ้นก่อน แล้วใบที่วันถ่ายใกล้วันนี้ที่สุด
 * การเลือกใบแรกให้เองคือการผูกคำขอกับกองที่ผิดโดยไม่มีใครรู้
 *
 * ใบที่ถูกลบ/ยกเลิกไม่นับ — ถ้าเจอแต่ใบพวกนั้นบอกเหตุผลตรง ๆ ไม่ใช่ "ไม่พบ"
 */
export function resolveMixTarget(
  query: string,
  bookings: MixTargetBooking[],
  me: string,
  now: Date = new Date(),
): MixResolution {
  const q = normalizeMixQuery(query)
  if (!q) return { kind: 'none', reason: 'พิมพ์ EP ID หรือ Booking ID' }
  const rawId = typeof query === 'string' ? query.trim() : ''

  const matchesCode = (b: MixTargetBooking) =>
    (!!b.bookingCode && normalizeMixQuery(b.bookingCode) === q) || (!!rawId && b.id === rawId)
  const matchesEp = (e: MixTargetEpisode) => normalizeMixQuery(e.episodeId) === q

  const touched = bookings.filter(b => matchesCode(b) || b.episodes.some(matchesEp))
  const live = touched.filter(b => !b.deletedAt && b.status !== 'CANCELLED')
  if (live.length === 0) {
    if (touched.some(b => b.status === 'CANCELLED' && !b.deletedAt)) {
      return { kind: 'none', reason: 'ใบจองนี้ถูกยกเลิกแล้ว — ถ้ายังต้องมิกซ์ ใส่ลิงก์ไฟล์เป็นงานเดี่ยวแทน' }
    }
    return { kind: 'none', reason: `ไม่พบใบจองหรือ EP ID "${q}" — ตรวจตัวสะกด หรือเลือกจากงานของฉัน` }
  }

  const byCode = live.find(matchesCode)
  if (byCode) {
    const single = byCode.episodes.length === 1 ? byCode.episodes[0].id : null
    return {
      kind: 'match',
      via: byCode.id === rawId && normalizeMixQuery(byCode.bookingCode || '') !== q ? 'bookingId' : 'bookingCode',
      pick: { bookingId: byCode.id, episodeRowId: single },
      needsEpisodePick: byCode.episodes.length > 1,
    }
  }

  const hits: Array<{ b: MixTargetBooking; e: MixTargetEpisode }> = []
  for (const b of live) for (const e of b.episodes) if (matchesEp(e)) hits.push({ b, e })
  if (hits.length === 1) {
    return { kind: 'match', via: 'episodeId', pick: { bookingId: hits[0].b.id, episodeRowId: hits[0].e.id }, needsEpisodePick: false }
  }
  const t = now.getTime()
  hits.sort((x, y) => {
    const mine = Number(involves(y.b, me)) - Number(involves(x.b, me))
    if (mine !== 0) return mine
    return Math.abs(dayMs(x.b.shootDate) - t) - Math.abs(dayMs(y.b.shootDate) - t)
  })
  return { kind: 'ambiguous', options: hits.map(h => ({ bookingId: h.b.id, episodeRowId: h.e.id })) }
}

/**
 * ตอนที่เลือกมาอยู่ในใบจองที่เลือกจริงไหม — ด่านฝั่งเซิร์ฟเวอร์ตอน POST
 *
 * ฟอร์มส่ง bookingId กับ episodeRowId แยกกัน ถ้าไม่ตรวจคู่กัน คำขอจะผูกใบ A กับตอนของใบ B ได้
 * (หน้าเว็บค้าง, ร่างเก่า, หรือ API ตรง) แล้วทีมเสียงจะไปหยิบไฟล์ผิดกอง
 */
export function episodeBelongsToBooking(
  episode: { bookingId: string } | null | undefined,
  bookingId: string,
): boolean {
  return !!episode && episode.bookingId === bookingId
}

/**
 * มีคำขอที่ยังเปิดอยู่ของงานเดียวกันไหม — ใบเดียวกัน และ (ตอนเดียวกัน หรือฝั่งใดฝั่งหนึ่งขอทั้งใบ)
 *
 * ไม่ห้ามขาด: งานเดียวกันอาจต้องมิกซ์สองเวอร์ชันจริง (ยาว/สั้น) ฟอร์มจึงถามยืนยันแทน
 * แต่ห้ามเงียบ — คำขอซ้ำที่ไม่มีใครรู้คือทีมเสียงทำงานเดียวกันสองรอบ
 */
export function findDuplicateMixJobs<T extends { bookingId?: string | null; episodeRowId?: string | null; status?: string | null; deletedAt?: Date | string | null }>(
  jobs: T[],
  pick: MixTargetPick,
): T[] {
  return jobs.filter(j =>
    !j.deletedAt
    && (OPEN_MIX_STATUSES as readonly string[]).includes(j.status || 'QUEUED')
    && j.bookingId === pick.bookingId
    && (!j.episodeRowId || !pick.episodeRowId || j.episodeRowId === pick.episodeRowId),
  )
}

/* ─────────────────────── v1.244 ปฏิทินภาระงานมิกซ์ ─────────────────────── */

/**
 * ความจุต่อวัน = วิศวกรเสียงที่ active × งานต่อคนต่อวัน
 * ponytail: 1 งาน/คน/วัน เป็นค่าเดา ไม่มีข้อมูลจริง (คิวเพิ่งเริ่มใช้) — ปรับตัวเลขนี้เมื่อมีงาน
 * DONE สัก 30 งานให้ดูว่าหนึ่งคนปิดได้วันละกี่งานจริง
 */
export const MIX_JOBS_PER_ENGINEER_PER_DAY = 1

export type MixLoadLevel = 'free' | 'light' | 'busy' | 'heavy'

export const MIX_LOAD_LABEL: Record<MixLoadLevel, string> = {
  free: 'ว่าง',
  light: 'เบา',
  busy: 'แน่น',
  heavy: 'หนาแน่นเกินกำลัง',
}

export function mixLoadLevel(count: number, engineers: number): MixLoadLevel {
  if (count <= 0) return 'free'
  const cap = Math.max(1, engineers) * MIX_JOBS_PER_ENGINEER_PER_DAY
  const ratio = count / cap
  if (ratio <= 0.5) return 'light'
  if (ratio <= 1) return 'busy'
  return 'heavy'
}

/** วันนี้ตามเวลาไทย เป็น 'YYYY-MM-DD' — dueDate เป็น @db.Date (เที่ยงคืน UTC ของวันนั้น) */
export function bangkokDateKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)
}

export function addDaysKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface MixCalendarDay {
  date: string
  /** งานที่ครบกำหนดวันนั้น ไม่นับยกเลิก/ลบ */
  total: number
  open: number
  done: number
  unassigned: number
  level: MixLoadLevel
  /** จำนวนงานที่ยังเปิดต่อคนที่ถูกแจก — Sound Admin ใช้ดูว่าใครแน่นวันไหน */
  byAssignee: Record<string, number>
}

export const MIX_CALENDAR_MAX_DAYS = 93

/**
 * นับงานต่อวันตามวันที่ต้องการไฟล์ ช่วง [from, to] รวมทั้งสองปลาย
 *
 * ระดับความแน่นคิดจาก **งานทั้งหมดที่ครบกำหนดวันนั้น (เปิด + ส่งแล้ว)** ไม่ใช่เฉพาะที่ยังเปิด:
 * คนขอดูปฏิทินเพื่อตอบว่า "วันนี้คนจองเยอะไหม" งานที่ส่งก่อนกำหนดก็ยังเป็นการจองของวันนั้น
 */
export function buildMixCalendar(
  jobs: Array<MixJobLike & { status?: string | null }>,
  from: string,
  to: string,
  engineers: number,
): MixCalendarDay[] {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) return []
  const days = new Map<string, MixCalendarDay>()
  for (let k = from, i = 0; k <= to && i < MIX_CALENDAR_MAX_DAYS; k = addDaysKey(k, 1), i++) {
    days.set(k, { date: k, total: 0, open: 0, done: 0, unassigned: 0, level: 'free', byAssignee: {} })
  }
  for (const j of jobs) {
    if (j.deletedAt || j.status === 'CANCELLED') continue
    const due = toDate(j.dueDate)
    if (!due) continue
    const day = days.get(due.toISOString().slice(0, 10))
    if (!day) continue
    day.total++
    if (j.status === 'DONE') { day.done++; continue }
    day.open++
    if (!j.assigneeEmail) day.unassigned++
    else {
      const who = j.assigneeEmail.toLowerCase()
      day.byAssignee[who] = (day.byAssignee[who] || 0) + 1
    }
  }
  const out = Array.from(days.values())
  for (const d of out) d.level = mixLoadLevel(d.total, engineers)
  return out
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
