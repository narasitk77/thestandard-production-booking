// v1.249 — ประวัติงานมิกซ์ (MixJobEvent) + ตัวเลขภาระ/ผลงานรายคน · กฎล้วน ไม่มี prisma — เทสได้
//
// คำขอ operator 29 ก.ย. 2569: "เก็บ data การทำงานมิกซ์เสียง เพื่อเก็บ performance และข้อมูลของทีมงานทุกคน
// ต้อง export.csv ได้ และมี dashboard monitor ใคร load มาก น้อย"
//
// นิยามที่ต้องตรงกันทุกที่ (dashboard · CSV รายคน · CSV รายงาน) — จึงคิดที่นี่ที่เดียว:
//  - **ถืองาน** = สถานะ IN_PROGRESS และมีคนทำ · ช่วงถืองานของแต่ละคนแยกกัน (แจกใหม่ A→B = A จบ B เริ่ม)
//  - **ได้รับงาน** = ช่วงถืองานใหม่ที่เริ่มในช่วงวันที่ (รอบแก้หลังส่งแล้วไม่นับเป็นงานใหม่)
//  - **ส่งงาน** = ครั้งแรกที่งานเป็น DONE ให้เครดิตคนที่ถืออยู่ตอนนั้น · ส่งซ้ำหลังเปิดแก้ = "ส่งแก้" แยกช่อง
//  - **ทันกำหนด** = วันที่ส่งครั้งแรก (เวลาไทย) ≤ วันที่ต้องการไฟล์ ณ ตอนส่ง · ไม่มีวันที่ = ไม่นับทั้งทันและไม่ทัน
//  - **เวลาทำ** = จากตอนที่คนนั้นเริ่มถืองาน ถึงตอนส่งครั้งแรก (ชั่วโมงจริง รวมกลางคืน/วันหยุด)
//  - **ภาระตอนนี้** = งาน IN_PROGRESS ที่ถืออยู่ขณะนี้ แยกตามความใกล้กำหนด
//  - **ลบคำขอ** ไม่ลบผลงานที่เกิดไปแล้ว (ผู้ตรวจเจอ: คนถืองานลบงานที่เลยกำหนดของตัวเองได้ แล้วงานหายจากทุกตัวเลข)
//    — ช่วงถืองาน/การส่งก่อนลบยังนับ · ไม่นับเป็นภาระตอนนี้ · คำขอที่ถูกถอนก่อนเคยแจก ไม่นับเป็นคำขอเข้า
//    · มีช่อง "ลบงานระหว่างถือ" ให้เห็นว่าใครลบงานที่ตัวเองถืออยู่
//  - เวลาที่ **ไม่รู้จริง** (งานก่อน v1.249 ที่ส่งแล้วถูกเปิดแก้ = deliveredAt เดิมถูกล้าง) ไม่ถูกเดาเป็นตัวเลข:
//    การส่งนั้นยังนับว่า "เคยส่ง" (รอบถัดไปจึงเป็นส่งแก้) แต่ไม่เข้าช่วงวันที่ ไม่ตัดสินทัน/ไม่ทัน ไม่คิดเวลาทำ

import { bangkokDateKey, addDaysKey, formatMixNumber, isValidISODate, MIX_STATUS_LABEL, type MixStatus } from './mix-jobs'

/* ───────────────────────────── ประเภทการเปลี่ยน ───────────────────────────── */

export const MIX_EVENT_KINDS = [
  'REQUESTED', 'ASSIGNED', 'REASSIGNED', 'CLAIMED', 'STARTED', 'DELIVERED', 'REOPENED',
  'REQUEUED', 'CANCELLED', 'RESTORED', 'DUE_CHANGED', 'EDITED', 'DELETED',
] as const
export type MixEventKind = (typeof MIX_EVENT_KINDS)[number]

export const MIX_EVENT_LABEL: Record<MixEventKind, string> = {
  REQUESTED: 'ส่งคำขอ',
  ASSIGNED: 'แจกงาน',
  REASSIGNED: 'เปลี่ยนคนทำ',
  CLAIMED: 'รับงานเอง',
  STARTED: 'เริ่มทำ',
  DELIVERED: 'ส่งงาน',
  REOPENED: 'เปิดงานกลับมาแก้',
  REQUEUED: 'ส่งกลับเข้าคิว',
  CANCELLED: 'ยกเลิก',
  RESTORED: 'เปิดคำขอกลับมา',
  DUE_CHANGED: 'เปลี่ยนวันที่ต้องการไฟล์',
  EDITED: 'แก้รายละเอียด',
  DELETED: 'ลบคำขอ',
}

/** สถานะของงาน ณ จุดหนึ่ง · dueDate เป็น 'YYYY-MM-DD' (วันล้วน) */
export interface MixState {
  status: string
  assigneeEmail: string | null
  dueDate: string | null
}

const norm = (e: string | null | undefined): string | null => (e && e.trim() ? e.trim().toLowerCase() : null)

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** วันล้วน (@db.Date = เที่ยงคืน UTC) → 'YYYY-MM-DD' · ไม่แปลงโซนเวลา ไม่งั้นเลื่อนวัน */
function dateOnly(v: Date | string | null | undefined): string | null {
  if (!v) return null
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const d = toDate(v)
  return d ? d.toISOString().slice(0, 10) : null
}

const toDbDate = (key: string | null | undefined): Date | null => (key ? new Date(`${key}T00:00:00Z`) : null)

export function mixStateOf(row: { status?: string | null; assigneeEmail?: string | null; dueDate?: Date | string | null }): MixState {
  return { status: row.status || 'QUEUED', assigneeEmail: norm(row.assigneeEmail), dueDate: dateOnly(row.dueDate) }
}

/**
 * การเปลี่ยนหนึ่งครั้งคืออะไร — หนึ่ง PATCH เปลี่ยนได้หลายอย่าง (แจก = เปลี่ยนคน + QUEUED→IN_PROGRESS)
 * จึงเลือกความหมายหลักตามลำดับ: สถานะปลายทางสำคัญ > เปลี่ยนคน > เริ่มทำ > เลื่อนวัน > แก้อื่น ๆ
 * · ตัวเลขทั้งหมดคิดจากสถานะก่อน/หลังที่เก็บคู่กัน ไม่ได้อ่านจากป้ายนี้ — ป้ายมีไว้ให้คนอ่าน CSV
 */
export function mixEventKind(before: MixState, after: MixState, opts: { claimed?: boolean; deleted?: boolean } = {}): MixEventKind {
  if (opts.deleted) return 'DELETED'
  if (after.status !== before.status) {
    if (after.status === 'DONE') return 'DELIVERED'
    if (before.status === 'DONE') return 'REOPENED'
    if (after.status === 'CANCELLED') return 'CANCELLED'
    if (before.status === 'CANCELLED') return 'RESTORED'
    if (after.status === 'QUEUED') return 'REQUEUED'
  }
  if (norm(after.assigneeEmail) !== norm(before.assigneeEmail)) {
    if (opts.claimed) return 'CLAIMED'
    return before.assigneeEmail ? 'REASSIGNED' : 'ASSIGNED'
  }
  if (after.status !== before.status) return 'STARTED'
  if (after.dueDate !== before.dueDate) return 'DUE_CHANGED'
  return 'EDITED'
}

/** แถวที่จะเขียนลง MixJobEvent (ใช้ใน nested create) · before=null = คำขอใหม่ */
export function mixEventData(
  before: MixState | null,
  after: MixState,
  actorEmail: string | null | undefined,
  opts: { claimed?: boolean; deleted?: boolean } = {},
) {
  return {
    kind: before ? mixEventKind(before, after, opts) : ('REQUESTED' as MixEventKind),
    actorEmail: norm(actorEmail),
    status: after.status,
    assigneeEmail: norm(after.assigneeEmail),
    dueDate: toDbDate(after.dueDate),
    fromStatus: before ? before.status : null,
    fromAssignee: before ? norm(before.assigneeEmail) : null,
    fromDueDate: before ? toDbDate(before.dueDate) : null,
  }
}

/* ───────────────────────────── เส้นเวลาของงานหนึ่งงาน ───────────────────────────── */

export interface MixEventLike {
  at: Date | string
  kind: string
  actorEmail?: string | null
  status: string
  assigneeEmail?: string | null
  dueDate?: Date | string | null
  fromStatus?: string | null
  fromAssignee?: string | null
  fromDueDate?: Date | string | null
}

export interface MixStatsJob {
  id: string
  number: number
  title: string
  status: string
  requesterEmail: string
  assigneeEmail?: string | null
  assignedByEmail?: string | null
  dueDate?: Date | string | null
  createdAt: Date | string
  updatedAt?: Date | string | null
  claimedAt?: Date | string | null
  deliveredAt?: Date | string | null
  deletedAt?: Date | string | null
  bookingCode?: string | null
  episodeCode?: string | null
  deliveryLink?: string | null
  sourceLink?: string | null
  events?: MixEventLike[]
}

export interface MixTimelineEvent {
  at: Date
  kind: string
  actorEmail: string | null
  state: MixState
  from: MixState | null
  /** true = สร้างจากแถวงาน เพราะงานมีอยู่ก่อนเริ่มเก็บประวัติ (v1.249) ไม่ใช่สิ่งที่บันทึกไว้จริง */
  synthetic: boolean
  /** false = เวลานี้เป็นแค่ขอบบน (ไม่รู้เวลาจริง) — ห้ามใช้ตัดสินทันกำหนด/ช่วงวันที่/เวลาทำ */
  timeKnown: boolean
}

/**
 * ประวัติเรียงตามเวลา · งานที่มีก่อน v1.249 ไม่มีแถว REQUESTED → สร้างช่วงต้นจากแถวงาน
 * (createdAt · claimedAt · deliveredAt) จนถึงสถานะ "ก่อน" ของประวัติจริงแถวแรก (หรือสถานะปัจจุบันถ้าไม่มีเลย)
 * เวลาที่สร้างขึ้นถูกบีบให้อยู่ระหว่าง createdAt กับประวัติจริงแถวแรก — ลำดับเวลาไม่กลับหัว
 */
export function mixTimeline(job: MixStatsJob): MixTimelineEvent[] {
  const real: MixTimelineEvent[] = []
  for (const e of job.events || []) {
    const at = toDate(e.at)
    if (!at) continue
    const isNew = e.fromStatus == null && e.kind === 'REQUESTED'
    real.push({
      at,
      kind: e.kind,
      actorEmail: norm(e.actorEmail),
      state: mixStateOf(e),
      from: isNew ? null : { status: e.fromStatus || 'QUEUED', assigneeEmail: norm(e.fromAssignee), dueDate: dateOnly(e.fromDueDate) },
      synthetic: false,
      timeKnown: true,
    })
  }
  real.sort((a, b) => a.at.getTime() - b.at.getTime())
  if (real[0]?.kind === 'REQUESTED') return real

  const first = real[0]
  const created = toDate(job.createdAt) ?? first?.at ?? new Date(0)
  const ceiling = first?.at ?? null
  const clamp = (d: Date | null): Date => {
    let t = d && d > created ? d : created
    if (ceiling && t > ceiling) t = ceiling
    return t
  }
  const base: MixState = first?.from ?? mixStateOf(job)
  const synth: MixTimelineEvent[] = []
  let cur: MixState = { status: 'QUEUED', assigneeEmail: null, dueDate: base.dueDate }
  const step = (kind: MixEventKind, at: Date | null, next: MixState, timeKnown = true) => {
    synth.push({ at: clamp(at), kind, actorEmail: null, state: next, from: synth.length ? cur : null, synthetic: true, timeKnown })
    cur = next
  }
  step('REQUESTED', created, cur)
  if (base.assigneeEmail && (base.status === 'IN_PROGRESS' || base.status === 'DONE')) {
    step('ASSIGNED', toDate(job.claimedAt), { status: 'IN_PROGRESS', assigneeEmail: base.assigneeEmail, dueDate: base.dueDate })
  }
  if (base.status === 'DONE') {
    // deliveredAt ในแถวเชื่อได้เฉพาะเมื่อไม่เลยประวัติจริงแถวแรก — เปิดแก้แล้ว ค่าเดิมถูกล้าง/ถูกทับด้วยรอบใหม่
    const delivered = toDate(job.deliveredAt)
    const known = !!delivered && (!ceiling || delivered <= ceiling)
    step('DELIVERED', known ? delivered : ceiling ?? toDate(job.updatedAt), { ...cur, status: 'DONE' }, known)
  }
  // ไม่มีคอลัมน์เวลายกเลิก: ไม่มีประวัติเลย = updatedAt คือการแก้ครั้งสุดท้าย (ใกล้เคียง) · มีประวัติ = รู้แค่ว่าก่อนแถวแรก
  if (base.status === 'CANCELLED') step('CANCELLED', ceiling ?? toDate(job.updatedAt), { ...cur, status: 'CANCELLED' }, !ceiling)
  if (!first && job.deletedAt) step('DELETED', toDate(job.deletedAt), cur)
  return [...synth, ...real]
}

/* ───────────────────────────── เล่นประวัติซ้ำ → ช่วงถืองาน + การส่ง ───────────────────────────── */

export type MixSegmentEnd = 'DELIVERED' | 'REASSIGNED' | 'REQUEUED' | 'CANCELLED' | 'DELETED'

export interface MixSegment {
  email: string
  start: Date
  end: Date | null
  endKind: MixSegmentEnd | null
  /** ถืองานรอบแก้ (หลังเคยส่งแล้ว) — ไม่นับเป็น "ได้รับงานใหม่" */
  revision: boolean
}

export interface MixDelivery {
  at: Date
  email: string | null
  dueDate: string | null
  /** ส่งครั้งแรกของงานนี้ · ครั้งถัดไป = ส่งแก้ */
  first: boolean
  /** เฉพาะครั้งแรกที่มีวันที่ต้องการไฟล์ · นอกนั้น null */
  onTime: boolean | null
  /** จากตอนที่คนส่งเริ่มถืองาน (ชั่วโมง) · null = ไม่รู้ว่าเริ่มถือเมื่อไร */
  hoursHeld: number | null
  /** false = ไม่รู้เวลาส่งจริง (ดู MixTimelineEvent.timeKnown) — ไม่นับเข้าช่วงวันที่ */
  timeKnown: boolean
}

export interface MixJobHistory {
  job: MixStatsJob
  timeline: MixTimelineEvent[]
  segments: MixSegment[]
  deliveries: MixDelivery[]
  requestedAt: Date
  firstAssignedAt: Date | null
  firstAssignee: string | null
  queueWaitHours: number | null
  reassignCount: number
  revisionCount: number
  /** เวลาที่งานเข้าสถานะจบปัจจุบัน (ส่งแล้ว/ยกเลิก/ลบ) · null = ยังเปิดอยู่ */
  endedAt: Date | null
  deleted: boolean
}

const hoursBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 3_600_000)
const holderOf = (s: MixState) => (s.status === 'IN_PROGRESS' ? norm(s.assigneeEmail) : null)

export function mixJobHistory(job: MixStatsJob): MixJobHistory {
  const timeline = mixTimeline(job)
  const segments: MixSegment[] = []
  const deliveries: MixDelivery[] = []
  let open: MixSegment | null = null
  let prev: MixState | null = null
  let delivered = false
  let reassignCount = 0
  let revisionCount = 0
  let firstAssignedAt: Date | null = null
  let firstAssignee: string | null = null
  let endedAt: Date | null = null
  let lastClosed: MixSegment | null = null

  for (const ev of timeline) {
    const s = ev.state
    const holder = ev.kind === 'DELETED' ? null : holderOf(s)
    if (open && open.email !== holder) {
      open.end = ev.at
      open.endKind = ev.kind === 'DELETED' ? 'DELETED'
        : s.status === 'DONE' ? 'DELIVERED'
        : s.status === 'CANCELLED' ? 'CANCELLED'
        : holder ? 'REASSIGNED'
        : 'REQUEUED'
      if (open.endKind === 'REASSIGNED') reassignCount++
      lastClosed = open
      open = null
    }
    if (s.status === 'DONE' && prev?.status !== 'DONE' && ev.kind !== 'DELETED') {
      const email = norm(s.assigneeEmail)
      const seg = lastClosed && lastClosed.end === ev.at && lastClosed.email === email ? lastClosed : null
      deliveries.push({
        at: ev.at,
        email,
        dueDate: s.dueDate,
        first: !delivered,
        onTime: ev.timeKnown && !delivered && s.dueDate ? bangkokDateKey(ev.at) <= s.dueDate : null,
        hoursHeld: ev.timeKnown && seg ? hoursBetween(seg.start, ev.at) : null,
        timeKnown: ev.timeKnown,
      })
      delivered = true
    }
    if (prev?.status === 'DONE' && s.status !== 'DONE' && ev.kind !== 'DELETED') revisionCount++
    if (holder && !open) {
      open = { email: holder, start: ev.at, end: null, endKind: null, revision: delivered }
      segments.push(open)
      if (!firstAssignedAt) { firstAssignedAt = ev.at; firstAssignee = holder }
    }
    // เวลาจบ = ตอนเข้าสถานะจบล่าสุด · เปิดกลับมา = ยังไม่จบ
    if (ev.kind === 'DELETED' || ((s.status === 'DONE' || s.status === 'CANCELLED') && prev?.status !== s.status)) endedAt = ev.at
    else if (s.status !== 'DONE' && s.status !== 'CANCELLED') endedAt = null
    prev = s
  }

  const requestedAt = timeline[0]?.at ?? toDate(job.createdAt) ?? new Date(0)
  return {
    job, timeline, segments, deliveries, requestedAt, firstAssignedAt, firstAssignee,
    queueWaitHours: firstAssignedAt ? hoursBetween(requestedAt, firstAssignedAt) : null,
    reassignCount, revisionCount, endedAt,
    deleted: !!job.deletedAt || timeline.some(e => e.kind === 'DELETED'),
  }
}

/* ───────────────────────────── ช่วงวันที่ ───────────────────────────── */

export interface MixStatsRange { from: string; to: string }

/** ช่วงที่ขอมา · ไม่ส่ง = เดือนนี้ (เวลาไทย) · ผิดรูป/กลับหัว/ยาวเกิน = error ดัง ๆ ไม่เดาให้ */
export function mixStatsRange(fromRaw: string | null | undefined, toRaw: string | null | undefined, today = bangkokDateKey()): MixStatsRange | { error: string } {
  const monthStart = `${today.slice(0, 7)}-01`
  const [y, m] = monthStart.split('-').map(Number)
  const d = new Date(0)
  d.setUTCFullYear(y, m, 0) // วันสุดท้ายของเดือน
  const monthEnd = d.toISOString().slice(0, 10)
  const from = fromRaw || monthStart
  const to = toRaw || (fromRaw ? today : monthEnd)
  if (!isValidISODate(from) || !isValidISODate(to)) return { error: 'วันที่ต้องเป็น YYYY-MM-DD' }
  if (from > to) return { error: 'ช่วงวันที่กลับหัว' }
  if (from < '2000-01-01' || to > '2100-12-31') return { error: 'ช่วงวันที่ไม่สมเหตุสมผล' }
  if (addDaysKey(from, 731) < to) return { error: 'ช่วงยาวเกิน 2 ปี — แบ่งดึงทีละช่วง' }
  return { from, to }
}

const inRange = (d: Date | null | undefined, r: MixStatsRange) => {
  if (!d) return false
  const k = bangkokDateKey(d)
  return k >= r.from && k <= r.to
}

/** งานที่ "มีชีวิต" ในช่วงนี้: ขอก่อนสิ้นช่วง และยังไม่จบก่อนต้นช่วง */
export function mixActiveInRange(h: MixJobHistory, r: MixStatsRange): boolean {
  if (bangkokDateKey(h.requestedAt) > r.to) return false
  return !h.endedAt || bangkokDateKey(h.endedAt) >= r.from
}

/* ───────────────────────────── ตัวเลขรายคน + ทีม ───────────────────────────── */

export type MixLoadBand = 'idle' | 'low' | 'normal' | 'high'

export const MIX_LOAD_BAND_LABEL: Record<MixLoadBand, string> = {
  idle: 'ว่าง',
  low: 'ภาระน้อย',
  normal: 'ปกติ',
  high: 'ภาระสูง',
}

/**
 * ภาระของคนหนึ่ง เทียบค่าเฉลี่ยทีม · ต้องห่างทั้งแบบสัมพัทธ์ (1.5 เท่า / ครึ่งหนึ่ง) และอย่างน้อย 1 งาน
 * — ทีม 4 คนงานน้อย ถ้าใช้แค่สัดส่วน คนที่มี 1 งานตอนค่าเฉลี่ย 0.5 จะกลายเป็น "ภาระสูง" ทั้งที่ไม่ใช่
 */
export function mixLoadBand(open: number, teamMean: number): MixLoadBand {
  if (open <= 0) return 'idle'
  if (open >= teamMean * 1.5 && open - teamMean >= 1) return 'high'
  if (open <= teamMean * 0.5 && teamMean - open >= 1) return 'low'
  return 'normal'
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

export interface MixPersonStats {
  email: string
  name: string | null
  /** อยู่ในรายชื่อทีมเสียงที่ active ตอนนี้ · false = เคยมีงาน แต่ไม่อยู่ในทีมแล้ว */
  inRoster: boolean
  // ── ตอนนี้ ──
  open: number
  openOverdue: number
  /** กำหนดส่งภายใน 2 วัน (ตรงกับธง "ใกล้กำหนด" บนการ์ด) */
  openDueSoon: number
  openLater: number
  openNoDue: number
  load: MixLoadBand
  // ── ในช่วงวันที่ ──
  assigned: number
  delivered: number
  onTime: number
  late: number
  noDue: number
  onTimeRate: number | null
  medianHoursHeld: number | null
  redelivered: number
  handedOff: number
  /** ลบคำขอทิ้งระหว่างที่ตัวเองถืองานอยู่ (ในช่วงวันที่) */
  deletedWhileHolding: number
}

export interface MixTeamStats {
  requested: number
  delivered: number
  onTime: number
  late: number
  onTimeRate: number | null
  medianHoursHeld: number | null
  medianQueueWaitHours: number | null
  cancelled: number
  /** ตอนนี้ */
  openQueued: number
  openInProgress: number
  openOverdue: number
  /** ภาระเฉลี่ยต่อคนในทีมเสียง (งานที่ถืออยู่) — ฐานของ mixLoadBand */
  meanOpenPerPerson: number
  rosterSize: number
}

export interface MixStats {
  range: MixStatsRange
  today: string
  team: MixTeamStats
  people: MixPersonStats[]
  histories: MixJobHistory[]
}

export function buildMixStats(
  jobs: MixStatsJob[],
  roster: { email: string; name?: string | null }[],
  range: MixStatsRange,
  today = bangkokDateKey(),
): MixStats {
  const histories = jobs.map(mixJobHistory)

  const people = new Map<string, MixPersonStats & { held: number[] }>()
  const person = (email: string) => {
    let p = people.get(email)
    if (!p) {
      p = {
        email, name: null, inRoster: false,
        open: 0, openOverdue: 0, openDueSoon: 0, openLater: 0, openNoDue: 0, load: 'idle',
        assigned: 0, delivered: 0, onTime: 0, late: 0, noDue: 0, onTimeRate: null, medianHoursHeld: null,
        redelivered: 0, handedOff: 0, deletedWhileHolding: 0, held: [],
      }
      people.set(email, p)
    }
    return p
  }
  for (const r of roster) {
    const e = norm(r.email)
    if (!e) continue
    const p = person(e)
    p.inRoster = true
    p.name = r.name?.trim() || null
  }

  const soon = addDaysKey(today, 2)
  const team: MixTeamStats = {
    requested: 0, delivered: 0, onTime: 0, late: 0, onTimeRate: null, medianHoursHeld: null,
    medianQueueWaitHours: null, cancelled: 0, openQueued: 0, openInProgress: 0, openOverdue: 0,
    meanOpenPerPerson: 0, rosterSize: roster.length,
  }
  const teamHeld: number[] = []
  const teamWait: number[] = []

  for (const h of histories) {
    const now = mixStateOf(h.job)
    // ── ตอนนี้ (คำขอที่ลบแล้วไม่ใช่ภาระ) ──
    if (!h.deleted && now.status === 'QUEUED') team.openQueued++
    const holder = h.deleted ? null : holderOf(now)
    if (holder) {
      team.openInProgress++
      const p = person(holder)
      p.open++
      if (!now.dueDate) p.openNoDue++
      else if (now.dueDate < today) { p.openOverdue++; team.openOverdue++ }
      else if (now.dueDate <= soon) p.openDueSoon++
      else p.openLater++
    } else if (!h.deleted && now.status === 'QUEUED' && now.dueDate && now.dueDate < today) {
      team.openOverdue++
    }
    // ── ในช่วง (ผลงานที่เกิดแล้วนับ แม้งานถูกลบทีหลัง) ──
    const withdrawn = h.deleted && h.segments.length === 0
    if (!withdrawn && inRange(h.requestedAt, range)) team.requested++
    if (!h.deleted && h.job.status === 'CANCELLED' && inRange(h.endedAt, range)) team.cancelled++
    if (h.firstAssignedAt && inRange(h.firstAssignedAt, range) && h.queueWaitHours !== null) teamWait.push(h.queueWaitHours)
    // งานเดียวกันนับ "ได้รับงาน" ให้คนเดิมครั้งเดียว — แจก A→B→A ไม่ใช่สองงานของ A (ผู้ตรวจเจอ)
    const credited = new Set<string>()
    for (const s of h.segments) {
      if (!s.revision && inRange(s.start, range) && !credited.has(s.email)) {
        credited.add(s.email)
        person(s.email).assigned++
      }
      if (s.endKind === 'REASSIGNED' && inRange(s.end, range)) person(s.email).handedOff++
      if (s.endKind === 'DELETED' && inRange(s.end, range)) person(s.email).deletedWhileHolding++
    }
    for (const d of h.deliveries) {
      if (!d.timeKnown || !inRange(d.at, range)) continue
      if (!d.first) {
        if (d.email) person(d.email).redelivered++
        continue
      }
      team.delivered++
      if (d.onTime === true) team.onTime++
      if (d.onTime === false) team.late++
      if (d.hoursHeld !== null) teamHeld.push(d.hoursHeld)
      if (!d.email) continue
      const p = person(d.email)
      p.delivered++
      if (d.onTime === true) p.onTime++
      else if (d.onTime === false) p.late++
      else p.noDue++
      if (d.hoursHeld !== null) p.held.push(d.hoursHeld)
    }
  }

  const rosterPeople = [...people.values()].filter(p => p.inRoster)
  const base = rosterPeople.length ? rosterPeople : [...people.values()]
  team.meanOpenPerPerson = base.length ? round1(base.reduce((n, p) => n + p.open, 0) / base.length)! : 0
  team.onTimeRate = team.onTime + team.late ? team.onTime / (team.onTime + team.late) : null
  team.medianHoursHeld = round1(median(teamHeld))
  team.medianQueueWaitHours = round1(median(teamWait))

  const out: MixPersonStats[] = [...people.values()].map(({ held, ...p }) => ({
    ...p,
    load: mixLoadBand(p.open, team.meanOpenPerPerson),
    onTimeRate: p.onTime + p.late ? p.onTime / (p.onTime + p.late) : null,
    medianHoursHeld: round1(median(held)),
  }))
    // ไม่อยู่ในทีมแล้วและไม่มีอะไรในช่วงนี้/ตอนนี้ = ไม่ต้องขึ้นแถว
    .filter(p => p.inRoster || p.open || p.assigned || p.delivered || p.redelivered || p.handedOff || p.deletedWhileHolding)
    .sort((a, b) => b.open - a.open || b.assigned - a.assigned || (a.name || a.email).localeCompare(b.name || b.email))

  return { range, today, team, people: out, histories }
}

/* ───────────────────────────── CSV ───────────────────────────── */

/** เวลาไทยแบบที่ Excel/ชีทอ่านเป็นวันที่ได้: 'YYYY-MM-DD HH:mm' */
export function bangkokDateTime(d: Date | null | undefined): string {
  if (!d) return ''
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16)
}

const statusText = (s: string) => MIX_STATUS_LABEL[s as MixStatus] || s
const yesNo = (b: boolean | null) => (b === true ? 'ทัน' : b === false ? 'ไม่ทัน' : '')
const pct = (r: number | null) => (r === null ? '' : Math.round(r * 100))

export const MIX_JOBS_CSV_COLUMNS = [
  'เลขงาน', 'ชื่องาน', 'ใบจอง', 'EP ID', 'คนขอ', 'ขอเมื่อ', 'วันที่ต้องการไฟล์', 'สถานะ', 'คนทำตอนนี้', 'คนแจกล่าสุด',
  'แจกครั้งแรกเมื่อ', 'คนทำคนแรก', 'รอแจก (ชม.)', 'ส่งครั้งแรกเมื่อ', 'คนส่ง', 'ทันกำหนด', 'เวลาทำ (ชม.)',
  'เปลี่ยนคนทำ (ครั้ง)', 'เปิดแก้ (ครั้ง)', 'ลิงก์ไฟล์ต้นทาง', 'ลิงก์ไฟล์ที่ส่ง', 'ลบแล้ว', 'ประวัติก่อนเริ่มเก็บ',
]

const UNKNOWN_TIME = 'ไม่ทราบ (ก่อนเริ่มเก็บประวัติ)'

export function mixJobCsvRow(h: MixJobHistory): unknown[] {
  const j = h.job
  const firstDelivery = h.deliveries.find(d => d.first) || null
  return [
    formatMixNumber(j.number), j.title, j.bookingCode || '', j.episodeCode || '', j.requesterEmail,
    bangkokDateTime(h.requestedAt), dateOnly(j.dueDate) || '', statusText(j.status), j.assigneeEmail || '', j.assignedByEmail || '',
    bangkokDateTime(h.firstAssignedAt), h.firstAssignee || '', round1(h.queueWaitHours) ?? '',
    firstDelivery && !firstDelivery.timeKnown ? UNKNOWN_TIME : bangkokDateTime(firstDelivery?.at),
    firstDelivery?.email || '', yesNo(firstDelivery?.onTime ?? null), round1(firstDelivery?.hoursHeld ?? null) ?? '',
    h.reassignCount, h.revisionCount, j.sourceLink || '', j.deliveryLink || '', h.deleted ? 'ใช่' : '',
    h.timeline.some(e => e.synthetic) ? 'ใช่' : '',
  ]
}

export const MIX_PEOPLE_CSV_COLUMNS = [
  'อีเมล', 'ชื่อ', 'อยู่ในรายชื่อทีมเสียง', 'ภาระตอนนี้', 'ถืออยู่ตอนนี้', 'เลยกำหนด', 'ใกล้กำหนด (≤2 วัน)', 'กำหนดหลังจากนั้น', 'ไม่มีกำหนด',
  'ได้รับงานในช่วง', 'ส่งงานในช่วง', 'ส่งทัน', 'ส่งไม่ทัน', 'ส่ง (ไม่มีกำหนด)', 'ทันกำหนด (%)', 'เวลาทำ มัธยฐาน (ชม.)', 'ส่งแก้', 'โอนงานต่อ', 'ลบงานระหว่างถือ',
]

export function mixPersonCsvRow(p: MixPersonStats): unknown[] {
  return [
    p.email, p.name || '', p.inRoster ? 'ใช่' : 'ไม่', MIX_LOAD_BAND_LABEL[p.load], p.open, p.openOverdue, p.openDueSoon, p.openLater, p.openNoDue,
    p.assigned, p.delivered, p.onTime, p.late, p.noDue, pct(p.onTimeRate), p.medianHoursHeld ?? '', p.redelivered, p.handedOff,
    p.deletedWhileHolding,
  ]
}

export const MIX_EVENTS_CSV_COLUMNS = [
  'เวลา', 'เลขงาน', 'ชื่องาน', 'เหตุการณ์', 'ทำโดย', 'สถานะก่อน', 'สถานะหลัง', 'คนทำก่อน', 'คนทำหลัง',
  'วันที่ต้องการไฟล์ก่อน', 'วันที่ต้องการไฟล์หลัง', 'ที่มา',
]

export function mixEventCsvRows(h: MixJobHistory, r: MixStatsRange): unknown[][] {
  return h.timeline.filter(e => inRange(e.at, r)).map(e => [
    e.timeKnown ? bangkokDateTime(e.at) : `${UNKNOWN_TIME} ก่อน ${bangkokDateTime(e.at)}`, formatMixNumber(h.job.number), h.job.title,
    MIX_EVENT_LABEL[e.kind as MixEventKind] || e.kind, e.actorEmail || '',
    e.from ? statusText(e.from.status) : '', statusText(e.state.status),
    e.from?.assigneeEmail || '', e.state.assigneeEmail || '',
    e.from?.dueDate || '', e.state.dueDate || '',
    e.synthetic ? 'สร้างจากข้อมูลงาน (ก่อนเริ่มเก็บประวัติ)' : 'บันทึกจริง',
  ])
}

/** ประวัติทุกงานในช่วง เรียงตามเวลาจริง (ไม่เรียงจากข้อความในช่องเวลา — แถวที่ไม่รู้เวลาขึ้นต้นด้วยตัวหนังสือ) */
export function mixEventsCsvRowsSorted(histories: MixJobHistory[], r: MixStatsRange): unknown[][] {
  const rows: { at: number; row: unknown[] }[] = []
  for (const h of histories) {
    const inside = h.timeline.filter(e => inRange(e.at, r))
    const built = mixEventCsvRows(h, r)
    inside.forEach((e, i) => rows.push({ at: e.at.getTime(), row: built[i] }))
  }
  return rows.sort((a, b) => a.at - b.at).map(x => x.row)
}

/** ดูตัวเลขผลงาน/ภาระรายคน + export ได้ไหม — Sound Admin กับแอดมิน/ผู้จัดการ (ข้อมูลผลงานรายคน ไม่เปิดทุกคน) */
export function canViewMixStats(access: { isCoordinator: boolean; canEditAll: boolean }): boolean {
  return access.isCoordinator || access.canEditAll
}
