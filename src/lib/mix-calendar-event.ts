// v1.245 — งานมิกซ์ → Google Calendar **ปฏิทินแยก** (กฎล้วน ๆ ไม่มี googleapis/prisma — เทสได้)
//
// คำสั่ง operator 28 ก.ย. 2569: "ยิง google calendar เป็นอันแยกได้ไหม ไม่ปนกับ probook เดิม · ทดสอบก่อน"
//
// สามเรื่องที่ตั้งใจ:
//  1. **ปฏิทินของตัวเอง** (`MIX_CALENDAR_ID`) ไม่ใช่ปฏิทินคิวถ่าย — ตั้งเป็น id เดียวกันด้วยความเผลอ
//     = ปฏิเสธดัง ๆ (mixCalendarTargetError) ไม่ใช่ยิงเข้าไปเงียบ ๆ แล้วปนกับกองถ่าย
//  2. **ไม่เชิญใคร** — ไม่มี attendees = Google ไม่ส่งเมลหาใคร · คนที่อยากเห็นกด subscribe ปฏิทินเอง
//     (คิวมิกซ์มีเมลของตัวเองอยู่แล้ว: คำขอใหม่/แจก/ส่งงาน — ปฏิทินมีไว้ "ดู" ไม่ใช่ "แจ้ง")
//  3. งานทั้งวันบนวันที่ต้องการไฟล์ + transparent — ไม่บล็อกเวลาว่างของใคร เพราะไม่ใช่นัดหมาย

import { MIX_STATUS_LABEL, formatMixNumber, type MixStatus } from './mix-jobs'

export interface MixCalendarJob {
  id: string
  number: number
  title: string
  status: string
  dueDate: Date | string | null
  deletedAt?: Date | string | null
  requesterEmail: string
  assigneeEmail?: string | null
  bookingCode?: string | null
  episodeCode?: string | null
  sourceLink?: string | null
  deliveryLink?: string | null
  notes?: string | null
  calendarEventId?: string | null
}

/**
 * ปฏิทินเป้าหมายใช้ได้ไหม · null = ใช้ได้
 * 'off' = ยังไม่ได้ตั้ง (ฟีเจอร์ปิด — ไม่ใช่ error) · ข้อความอื่น = ตั้งผิด ต้องดัง
 */
export function mixCalendarTargetError(mixId: string | null | undefined, bookingCalendarIds: string[]): string | null | 'off' {
  const id = (mixId || '').trim().toLowerCase()
  if (!id) return 'off'
  // id ปฏิทิน Google เป็น ASCII ล้วน · ค่าที่วางมาพร้อมอักขระแปลก (ไทย/ช่องว่างกลาง/zero-width) = ตั้งผิด
  // ต้องดังที่นี่ที่เดียว: ซิงก์ปฏิเสธ + ไม่มีปุ่มลิงก์ (เดิม btoa โยน error ทำ /api/mix/calendar ล้มทั้งหน้า)
  if (!/^[\x21-\x7e]+$/.test(id)) return 'MIX_CALENDAR_ID มีอักขระที่ไม่ใช่ id ปฏิทิน (นอก ASCII หรือช่องว่างกลาง) — ตรวจค่าบน stack'
  if (bookingCalendarIds.map(s => s.trim().toLowerCase()).includes(id)) {
    return 'MIX_CALENDAR_ID ชี้ไปปฏิทินคิวถ่ายเดิม — ต้องเป็นปฏิทินแยก (ไม่ยิงเพื่อกันงานมิกซ์ปนกับกองถ่าย)'
  }
  return null
}

/**
 * v1.246 — ลิงก์เปิดปฏิทินมิกซ์ใน Google Calendar (หน้าปฏิทิน + ป๊อปอัปในฟอร์มขอมิกซ์)
 * `?cid=` = base64 ของ id ปฏิทิน — Google เปิดปฏิทินนั้นและถามว่าจะเพิ่มลงรายการของฉันไหม
 * · ปฏิทินแชร์ทั้งโดเมน thestandard.co (ผู้ใช้ทุกคนในระบบอยู่โดเมนนี้ ตรวจ 29 ก.ย. 2569)
 * · null เมื่อปิด **หรือตั้งผิด** — ปุ่มที่พาไปปฏิทินคิวถ่ายเท่ากับบอกคนดูว่านั่นคือคิวมิกซ์
 */
export function mixCalendarViewUrl(
  mixId: string | null | undefined, bookingCalendarIds: string[], viewerEmail?: string | null,
): string | null {
  if (mixCalendarTargetError(mixId, bookingCalendarIds) !== null) return null
  const cid = btoa(mixId!.trim()).replace(/=+$/, '')
  // u/0 = บัญชี Google แรกในเบราว์เซอร์ · คนที่ล็อกอินบัญชีส่วนตัวไว้ก่อนจะเจอ "ไม่มีสิทธิ์" ·
  // authuser=<อีเมลคนดู> ให้ Google สลับไปบัญชีงานเอง (อีเมลของคนดูเอง ส่งให้ Google ที่เป็นเจ้าของบัญชีนั้น)
  const who = viewerEmail?.trim() ? `&authuser=${encodeURIComponent(viewerEmail.trim())}` : ''
  return `https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(cid)}${who}`
}

export type MixCalendarPlan = 'create' | 'update' | 'delete' | 'none'

/** งานนี้ควรมี event ไหม: ยังไม่ลบ · ไม่ยกเลิก · มีวันที่ต้องการไฟล์ */
export function mixJobWantsEvent(job: MixCalendarJob): boolean {
  return !job.deletedAt && job.status !== 'CANCELLED' && !!job.dueDate
}

/**
 * ต้องทำอะไรกับปฏิทิน — ใช้ตัวเดียวกันทั้ง dry-run และของจริง (บทเรียน dry-run ≠ ของจริง ซ้ำ 3 ครั้ง)
 */
export function planMixCalendar(job: MixCalendarJob): MixCalendarPlan {
  const wants = mixJobWantsEvent(job)
  if (wants) return job.calendarEventId ? 'update' : 'create'
  return job.calendarEventId ? 'delete' : 'none'
}

function dayKey(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

function nextDayKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const short = (email?: string | null) => (email ? email.split('@')[0] : '')

/** สีตามสถานะ (colorId ของ Google Calendar) — Requested เหลือง · Assigned น้ำเงิน · Completed เขียว */
const STATUS_COLOR: Record<string, string> = { QUEUED: '5', IN_PROGRESS: '9', DONE: '10' }

/**
 * event id ที่คำนวณจาก id งาน — **กันสร้างซ้ำโดยไม่ต้องพึ่ง DB** (ผู้ตรวจเจอ: insert สำเร็จแต่บันทึก
 * calendarEventId ไม่ทัน หรือสองคำขอซิงก์พร้อมกัน = event ซ้ำค้างในปฏิทิน) · id ซ้ำ Google ตอบ 409
 * → เปลี่ยนเป็น patch · Google รับเฉพาะ base32hex (a-v, 0-9) 5–1024 ตัว → hex ของ id งานผ่านเสมอ
 */
export function mixEventId(jobId: string): string {
  const hex = Array.from(new TextEncoder().encode(jobId)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `mc${hex}`
}

/** ชื่อ + รายละเอียด event · คืน requestBody ที่ส่ง events.insert/patch ได้ตรง ๆ */
export function buildMixCalendarEvent(job: MixCalendarJob, appUrl = '') {
  const due = dayKey(job.dueDate as Date | string)
  const status = job.status as MixStatus
  const who = job.status === 'QUEUED' ? 'รอแจก' : short(job.assigneeEmail)
  const done = job.status === 'DONE'
  const summary = `${done ? '✅ ' : '🎚 '}${formatMixNumber(job.number)} · ${job.title}${who ? ` · ${who}` : ''}`.slice(0, 250)
  const url = appUrl.replace(/\/+$/, '')
  const description = [
    `สถานะ: ${MIX_STATUS_LABEL[status] || job.status}`,
    job.bookingCode ? `ใบจอง: ${job.bookingCode}${job.episodeCode && job.episodeCode !== job.bookingCode ? ` · ตอน ${job.episodeCode}` : ''}` : null,
    `ผู้ขอ: ${job.requesterEmail}`,
    job.assigneeEmail ? `คนมิกซ์: ${job.assigneeEmail}` : 'คนมิกซ์: ยังไม่แจก',
    job.sourceLink ? `ไฟล์ต้นทาง: ${job.sourceLink}` : null,
    job.deliveryLink ? `ไฟล์ที่มิกซ์แล้ว: ${job.deliveryLink}` : null,
    job.notes ? `โน้ต: ${job.notes}` : null,
    '',
    url ? `คิวมิกซ์: ${url}/mix` : null,
    `Probook ${formatMixNumber(job.number)}`,
  ].filter(v => v !== null).join('\n')
  return {
    summary,
    description,
    start: { date: due },
    end: { date: nextDayKey(due) },
    transparency: 'transparent' as const,
    // event ที่ถูกลบในแอปปฏิทินยังอยู่เป็น status=cancelled — patch พร้อม confirmed ดึงกลับมาได้เสมอ
    status: 'confirmed' as const,
    colorId: STATUS_COLOR[job.status] || '8',
    extendedProperties: { private: { probookMixId: job.id } },
  }
}
