/**
 * v1.211 — บันทึกงานไลฟ์ของสวิตเชอร์ (ตรรกะล้วน ไม่แตะ DB)
 *
 * ที่มา: งานสวิตช์ไลฟ์ลงโซเชียลถูกสั่งกันในกลุ่มไลน์ ไม่เคยผ่าน booking flow
 * ระบบจึงไม่รู้ว่ามีงานนี้อยู่เลย — ใครคุมไลฟ์ไหน กี่ชั่วโมง ลิงก์อยู่ที่ไหน
 * ตอบไม่ได้สักข้อ หน้า /switcher ให้สวิตเชอร์มาลงเอง และไฟล์นี้คือกฎกลาง
 * ที่ทั้ง API และหน้าเว็บใช้ร่วมกัน (เลข, ลิงก์, ชั่วโมง, สิทธิ์แก้ไข)
 *
 * ทำไมแยกไฟล์บริสุทธิ์: บทเรียน v1.193 — กฎ "ใครแก้ได้แค่ไหน" ถูกเขียนซ้ำ 3 ที่
 * แล้วเพี้ยนคนละทาง จนมีใบที่ไม่มีใครแก้ได้เลย ที่นี่จึงมีที่เดียว
 */

import { parseEpisodeId } from './episode-id'

/**
 * ส่วน [PROG] ของ Production ID งานไลฟ์ — `NWS-LIV-260829-01`
 *
 * ตั้งใจใช้รหัสที่ **ไม่มีในลิสต์รายการของ outlet ไหนเลย** (src/lib/data.ts)
 * ลำดับเลขของ booking วิ่งต่อ outlet+รายการ+วัน ฉะนั้นการที่ 'LIV' ไม่ใช่รหัส
 * รายการจริง = สายเลขของงานไลฟ์แยกขาดจากสายของงานถ่าย ชนกันไม่ได้ตามนิยาม
 * (ถ้าวันหนึ่งมีคนเพิ่มรายการรหัส LIV เข้าไปใน data.ts เลขจะเริ่มปนกัน —
 *  มีเทสต์ใน switcher-jobs.test.ts ยืนกันไว้แล้ว)
 */
export const SWITCHER_PROGRAM_CODE = 'LIV'

export const SWITCHER_PLATFORMS = ['YOUTUBE', 'FACEBOOK', 'TIKTOK', 'OTHER'] as const
export type SwitcherPlatform = (typeof SWITCHER_PLATFORMS)[number]

export const PLATFORM_LABEL: Record<SwitcherPlatform, string> = {
  YOUTUBE: 'YouTube',
  FACEBOOK: 'Facebook',
  TIKTOK: 'TikTok',
  OTHER: 'อื่น ๆ',
}

export interface SwitcherLink {
  platform: SwitcherPlatform
  url: string
}

export const SWITCHER_STATUSES = ['DRAFT', 'LOGGED'] as const
export type SwitcherStatus = (typeof SWITCHER_STATUSES)[number]

/** รูปแถวเท่าที่ตรรกะในไฟล์นี้ต้องรู้ (API ส่ง row ของ Prisma มาได้ตรง ๆ) */
export interface SwitcherJobLike {
  id?: string
  productionId?: string | null
  status?: string | null
  switcherEmail?: string | null
  startTime?: string | null
  endTime?: string | null
  endDayOffset?: number | null
  links?: unknown
}

// ── วันที่ ────────────────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD ที่เป็นวันจริง และอยู่ในช่วงปีที่เป็นไปได้
 *
 * ช่วงปี 2020–2099 กันเคสที่เคยกัดจริง (memo: _SHOOT marker ปี 3112): ปี พ.ศ.
 * หลุดเข้ามา 2569 → เลขกลายเป็น `NWS-LIV-690829-01` ซึ่งผิดถาวรเพราะเลข
 * immutable · ที่นี่เลือก **ปฏิเสธ** แทนการแปลงเงียบ ๆ เพราะ <input type="date">
 * ส่งค.ศ. เสมอ ถ้าได้ พ.ศ. มาแปลว่ามาจากทางอื่นและควรรู้ตัว
 */
export function isValidISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (y < 2020 || y > 2099) return false
  if (m < 1 || m > 12) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * 'YYYY-MM-DD' → 'YYMMDD' โดย **ไม่แตะ Date เลย**
 *
 * episode-id.formatShootDateForId ใช้ getFullYear/getMonth/getDate ซึ่งอ่านตาม
 * โซนเวลาของเครื่อง — บน prod (UTC) ถูก แต่ผูกกับสภาพแวดล้อมโดยไม่จำเป็น
 * งานไลฟ์รับค่ามาเป็นสตริงอยู่แล้ว จึงตัดสตริงตรง ๆ ไม่มีทางเพี้ยนข้ามวัน
 */
export function yymmddFromISODate(iso: string): string {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10)
}

/** Date สำหรับคอลัมน์ @db.Date (Prisma เก็บเป็นเที่ยงคืน UTC) */
export function isoDateToUTC(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

/** Date ของคอลัมน์ @db.Date → 'YYYY-MM-DD' */
export function utcDateToISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ── Production ID ─────────────────────────────────────────────────────────────

/** คำนำหน้าของสายเลขวันนั้น เช่น `NWS-LIV-260829-` */
export function switcherIdPrefix(outletCode: string, isoDate: string): string {
  return `${outletCode.toUpperCase()}-${SWITCHER_PROGRAM_CODE}-${yymmddFromISODate(isoDate)}-`
}

/**
 * เลขลำดับถัดไปของ outlet+วันนั้น = มากสุดที่เคยออก + 1
 *
 * รับ ID ที่มีอยู่แล้วทั้งหมดของ prefix นั้น (รวมของแถวที่ soft-delete ไปแล้ว
 * ด้วย — เลขที่ออกไปแล้วห้ามถูกใช้ซ้ำ ต่อให้แถวถูกลบ) แล้วอ่านลำดับด้วย
 * parseEpisodeId ตัวเดียวกับที่ระบบ booking ใช้ ID ที่อ่านไม่ออกถูกข้าม —
 * ปลอดภัยกว่าปล่อยให้ NaN ไปทำให้ผลลัพธ์เพี้ยนทั้งก้อน
 */
export function nextSwitcherSequence(existingIds: Array<string | null | undefined>): number {
  let max = 0
  for (const id of existingIds) {
    if (!id) continue
    const parsed = parseEpisodeId(id)
    if (parsed && parsed.sequence > max) max = parsed.sequence
  }
  return max + 1
}

/**
 * `NWS-LIV-260829-01` — รูปเดียวกับ Production ID ของงานถ่าย จึงแปะที่ไหนก็อ่านออก
 *
 * ประกอบจากสตริงเอง ไม่เรียก generateEpisodeId เพราะตัวนั้นรับ Date แล้วอ่าน
 * ด้วย getFullYear/getMonth/getDate = ผลขึ้นกับโซนเวลาของเครื่องที่รัน
 * (prod เป็น UTC จึงถูก แต่เครื่อง dev ที่ offset ติดลบจะได้วันก่อนหน้า)
 * สัญญาว่า "รูปเหมือนกัน" ถูกยึดไว้ด้วยเทสต์ที่ parse กลับด้วย parseEpisodeId
 */
export function buildSwitcherProductionId(outletCode: string, isoDate: string, seq: number): string {
  const prefix = switcherIdPrefix(outletCode, isoDate)
  return `${prefix}${String(seq).padStart(2, '0')}`
}

/** เลขนี้เป็นของงานไลฟ์ไหม (ใช้แยกออกจาก Production ID ของงานถ่าย) */
export function isSwitcherProductionId(id: string | null | undefined): boolean {
  if (!id) return false
  const parsed = parseEpisodeId(id)
  return parsed?.programCode === SWITCHER_PROGRAM_CODE
}

// ── ลิงก์ออกอากาศ ─────────────────────────────────────────────────────────────

/**
 * รับได้เฉพาะ http/https เท่านั้น — ลิงก์พวกนี้ถูกเรนเดอร์เป็น <a href> ให้คนอื่น
 * กด `javascript:` / `data:` ที่หลุดเข้ามาจะกลายเป็นช่องยิงสคริปต์ใส่คนอ่าน
 */
export function isValidHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function isSwitcherPlatform(v: unknown): v is SwitcherPlatform {
  return typeof v === 'string' && (SWITCHER_PLATFORMS as readonly string[]).includes(v)
}

/**
 * แปลง links ที่ client ส่งมาให้เป็นรูปที่เก็บได้ หรือบอกว่าผิดตรงไหน
 *
 * แถวที่ url ว่างถูก "ตัดทิ้งเงียบ ๆ" ตั้งใจ: ฟอร์มมีช่องลิงก์เปล่าค้างไว้เสมอ
 * (ลิงก์มาทีหลัง) ถ้าตีเป็น error คนจะกรอกงานไม่ได้ทั้งใบ · แต่ url ที่กรอกแล้ว
 * ผิดรูป **ต้องฟ้อง** ไม่ใช่ตัดทิ้ง ไม่งั้นคนกรอกจะนึกว่าบันทึกไปแล้ว
 */
export function normalizeLinks(raw: unknown): { ok: true; links: SwitcherLink[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, links: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'links ต้องเป็น array' }
  if (raw.length > 10) return { ok: false, error: 'ใส่ลิงก์ได้สูงสุด 10 อัน' }
  const links: SwitcherLink[] = []
  for (const item of raw) {
    const url = typeof (item as any)?.url === 'string' ? (item as any).url.trim() : ''
    if (!url) continue
    if (!isValidHttpUrl(url)) return { ok: false, error: `ลิงก์ไม่ถูกต้อง: ${url.slice(0, 80)} (ต้องขึ้นต้นด้วย http:// หรือ https://)` }
    const platform = isSwitcherPlatform((item as any)?.platform) ? (item as any).platform : guessPlatform(url)
    links.push({ platform, url })
  }
  return { ok: true, links }
}

/** เดาแพลตฟอร์มจาก host เมื่อคนวางลิงก์มาเฉย ๆ ไม่ได้เลือกช่อง */
export function guessPlatform(url: string): SwitcherPlatform {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'OTHER'
  }
  if (host.includes('youtube.') || host.includes('youtu.be')) return 'YOUTUBE'
  if (host.includes('facebook.') || host.includes('fb.watch') || host.includes('fb.com')) return 'FACEBOOK'
  if (host.includes('tiktok.')) return 'TIKTOK'
  return 'OTHER'
}

/** อ่าน links ที่เก็บใน Json column กลับมาเป็น array ที่ใช้ได้ (พังก็คืนว่าง) */
export function readLinks(raw: unknown): SwitcherLink[] {
  const parsed = normalizeLinks(raw)
  return parsed.ok ? parsed.links : []
}

// ── เวลาทำงาน ─────────────────────────────────────────────────────────────────

export function hhmmToMinutes(hhmm: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * นาทีที่ทำงานจริง · null = ยังไม่ได้กรอกเวลา หรือกรอกมาแล้วไม่สมเหตุผล
 *
 * ไลฟ์ดึกจบข้ามเที่ยงคืนได้ จึงใช้ endDayOffset แทนการบังคับ end > start
 * (เหมือน OT v1.42 ที่กะข้ามคืนถูกบล็อกอยู่นาน)
 */
export function jobDurationMinutes(job: SwitcherJobLike): number | null {
  if (!job.startTime || !job.endTime) return null
  const s = hhmmToMinutes(job.startTime)
  const e = hhmmToMinutes(job.endTime)
  if (s === null || e === null) return null
  const offset = job.endDayOffset === 1 ? 1 : 0
  const mins = offset * 1440 + e - s
  if (mins <= 0 || mins > 1440) return null
  return mins
}

/** 95 → '1 ชม. 35 นาที' */
export function formatDuration(mins: number | null): string {
  if (mins === null) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m} นาที`
  if (m === 0) return `${h} ชม.`
  return `${h} ชม. ${m} นาที`
}

// ── สถานะ / การตามงาน ─────────────────────────────────────────────────────────

/**
 * แถวนี้ยังต้องตามให้สวิตเชอร์มาเติมอะไรไหม
 *
 * ตอบแยกเป็นเหตุผล ไม่ใช่ boolean เดียว เพราะ "ยังไม่มีใครรับงาน" กับ
 * "รับแล้วแต่ลิงก์ยังไม่มา" ต้องตามคนละคนคนละแบบ (บทเรียนเดียวกับ v1.209.1
 * ที่ยุบผลราย channel เป็น boolean เดียวแล้วบอกไม่ได้ว่าช่องไหนล้ม)
 */
export type FollowUpReason = 'UNCLAIMED' | 'NO_LINK' | 'NO_TIME' | null

export function followUpReason(job: SwitcherJobLike): FollowUpReason {
  if ((job.status || 'LOGGED') === 'DRAFT') return 'UNCLAIMED'
  if (!job.startTime || !job.endTime) return 'NO_TIME'
  if (readLinks(job.links).length === 0) return 'NO_LINK'
  return null
}

export const FOLLOW_UP_LABEL: Record<Exclude<FollowUpReason, null>, string> = {
  UNCLAIMED: 'ยังไม่มีสวิตเชอร์รับ',
  NO_TIME: 'ยังไม่ใส่เวลาทำงาน',
  NO_LINK: 'ยังไม่ใส่ลิงก์',
}

// ── สิทธิ์ ────────────────────────────────────────────────────────────────────

export interface SwitcherActor {
  email: string
  /** ADMIN / MANAGER — แก้ได้ทุกแถว (ไว้ซ่อมของคนอื่นเวลาข้อมูลผิด) */
  canEditAll: boolean
}

/**
 * แก้/ลบแถวนี้ได้ไหม
 *
 * แถว DRAFT ที่ยังไม่มีเจ้าของ = สวิตเชอร์คนไหนก็ "รับ" ได้ — นั่นคือทั้งหมด
 * ที่ระบบเตรียมแถวไว้เพื่อ · ส่วนแถวที่มีเจ้าของแล้ว เจ้าตัวเท่านั้น (+admin)
 */
export function canEditSwitcherJob(actor: SwitcherActor, job: SwitcherJobLike): boolean {
  if (actor.canEditAll) return true
  if (!job.switcherEmail) return (job.status || 'LOGGED') === 'DRAFT'
  return job.switcherEmail.toLowerCase() === actor.email.toLowerCase()
}

/**
 * ช่องที่ล็อกหลังออกเลขแล้ว
 *
 * outletCode + workDate ประกอบเป็นตัวเลขไปแล้ว แก้ได้เมื่อไหร่ = แถวที่เลขบอก
 * วันหนึ่งแต่ข้อมูลบอกอีกวัน ซึ่งคือ drift แบบเดียวกับที่โฟลเดอร์ไดรฟ์เคยเป็น
 * ทางออกถ้ากรอกผิดคือลบแถวแล้วเพิ่มใหม่ (เลขเก่าไม่ถูกใช้ซ้ำ)
 */
export function idFieldsLocked(job: SwitcherJobLike): boolean {
  return !!job.productionId
}

// ── ตรวจข้อมูลที่ส่งเข้ามา ────────────────────────────────────────────────────

export interface ValidSwitcherPayload {
  outletCode: string
  jobName: string
  workDate: string
  startTime: string
  endTime: string
  endDayOffset: number
  links: SwitcherLink[]
  requestedBy: string | null
  notes: string | null
}

function trimOrNull(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : null
}

/**
 * กฎของ "แถวที่กรอกครบแล้ว" — ใช้ร่วมกันทั้ง POST (ลงใหม่) และ PATCH (แก้/รับงาน)
 *
 * อยู่ที่เดียวเพราะสองเส้นทางนี้เขียนลงคอลัมน์ชุดเดียวกัน ถ้าตรวจคนละชุดจะได้
 * แถวที่ "สร้างไม่ได้แต่แก้ให้เป็นแบบนั้นได้" ซึ่งคือรูตัวใหญ่ที่ข้อมูลเสียลอดเข้ามา
 */
export function validateSwitcherPayload(
  body: any,
  isKnownOutlet: (code: string) => boolean,
): ValidSwitcherPayload | { error: string } {
  const outletCode = String(body?.outletCode || '').trim().toUpperCase()
  if (!isKnownOutlet(outletCode)) return { error: `ไม่รู้จักสังกัด: ${outletCode || '(ว่าง)'}` }

  const jobName = String(body?.jobName ?? '').trim()
  if (!jobName) return { error: 'ต้องใส่ชื่อหมาย' }
  if (jobName.length > 200) return { error: 'ชื่อหมายยาวเกิน 200 ตัวอักษร' }

  const workDate = String(body?.workDate || '').trim()
  if (!isValidISODate(workDate)) return { error: 'วันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD ปี ค.ศ.)' }

  const startTime = String(body?.startTime || '').trim()
  const endTime = String(body?.endTime || '').trim()
  if (hhmmToMinutes(startTime) === null || hhmmToMinutes(endTime) === null) {
    return { error: 'เวลาต้องเป็น HH:MM แบบ 24 ชม. (เช่น 09:00)' }
  }
  const endDayOffset = body?.endDayOffset === 1 || body?.endDayOffset === '1' ? 1 : 0
  if (jobDurationMinutes({ startTime, endTime, endDayOffset }) === null) {
    return {
      error: endDayOffset === 1
        ? 'เวลาจบต้องอยู่หลังเวลาเริ่ม และรวมแล้วไม่เกิน 24 ชม.'
        : 'เวลาจบต้องอยู่หลังเวลาเริ่ม — ถ้าไลฟ์ข้ามเที่ยงคืน ให้ติ๊ก "จบวันถัดไป"',
    }
  }

  const linksParsed = normalizeLinks(body?.links)
  if (!linksParsed.ok) return { error: linksParsed.error }

  return {
    outletCode,
    jobName,
    workDate,
    startTime,
    endTime,
    endDayOffset,
    links: linksParsed.links,
    requestedBy: trimOrNull(body?.requestedBy, 120),
    notes: trimOrNull(body?.notes, 2000),
  }
}
