/**
 * v1.184 — กระดิ่งแจ้งเตือนข้าง "New Booking": ชนิดของ event, ลำดับความสำคัญ,
 * และ allowlist ว่าเจ้าของงานเห็นอะไรได้
 *
 * ไฟล์นี้ไม่ import prisma เลย → ใช้ได้ทั้งฝั่ง server (notifications.ts) และ
 * client (NotificationBell) และเทสได้โดยไม่ต้องมี DB
 *
 * ทำไมไม่มีตาราง Notification: feed ทั้งหมด **derive จากสถานะจริง** — คิวยกเลิก
 * อ่านคอลัมน์เดียวกับที่แท็บ "ขอยกเลิก" อ่าน, คิวแก้ไขอ่าน audit log, error อ่าน
 * heartbeat ตัวเดียวกับ /admin/health. ตัวเลขบนกระดิ่งจึงไม่มีทางไม่ตรงกับคิว
 * (รีโปนี้เจ็บกับตารางที่ drift จากความจริงมาหลายรอบ) สิ่งเดียวที่เก็บเพิ่มคือ
 * "คนนี้เปิดกระดิ่งล่าสุดเมื่อไหร่"
 */

import { hasConsoleAccess, type Role } from './roles'
import { resolveTier } from './tiers'

export type NotifKind =
  | 'cancel_request'   // [admin] คนขอยกเลิกงาน — ต้องตัดสิน
  | 'edit_request'     // [admin] Producer ขอแก้เวลา / ส่งอัปเดต
  | 'system_error'     // [admin] worker ค้าง / ไม่เคย tick
  | 'booking_outcome'  // [เจ้าของงาน] ผลที่เกิดกับงานของตัวเอง

/** ลำดับที่ operator สั่ง: ยกเลิก → แก้ไข → error (เลขน้อย = ขึ้นก่อน) */
export const KIND_PRIORITY: Record<NotifKind, number> = {
  cancel_request: 1,
  edit_request: 2,
  system_error: 3,
  booking_outcome: 4,
}

export const KIND_LABEL: Record<NotifKind, string> = {
  cancel_request: 'ขอยกเลิก',
  edit_request: 'ขอแก้ไข',
  system_error: 'ระบบขัดข้อง',
  booking_outcome: 'งานของฉัน',
}

export interface NotifItem {
  /** id เสถียรต่อ event เดียว — ใช้เป็น React key และกันซ้ำ */
  id: string
  kind: NotifKind
  /** ISO. null = สภาพที่ค้างอยู่โดยไม่มีจุดเริ่มที่วัดได้ (worker ที่ไม่เคย tick) */
  at: string | null
  title: string
  detail?: string | null
  href: string
  code?: string | null
}

/**
 * Action ที่ "เจ้าของงาน" เห็นได้ — FAIL-CLOSED เหมือน booking-history-visibility:
 * action ที่ไม่อยู่ในนี้ = มองไม่เห็น ไม่ใช่โผล่มาโดยปริยาย
 *
 * เกณฑ์: ต้องเป็น **ผลที่คนอื่นทำกับงานของเขา** และเป็นข้อมูลที่เขาเปิดหน้างาน
 * ตัวเองก็เห็นอยู่แล้ว — กระดิ่งแค่บอกว่า "มันเกิดขึ้นเมื่อไหร่" ไม่เปิดเผยของใหม่
 * ห้ามใส่ action ของฟีเจอร์ที่ตั้งใจให้ไม่ระบุตัวตน (peer review) เด็ดขาด
 */
export const OWNER_OUTCOME_LABELS: Record<string, string> = {
  approve: 'งานได้รับอนุมัติแล้ว',
  reject: 'งานถูกปฏิเสธ',
  'booking.status_change': 'สถานะงานเปลี่ยน',
  'booking.force_status': 'แอดมินตั้งสถานะใหม่',
  'booking.update': 'แอดมินแก้รายละเอียดงาน',
  'booking.episodes_added': 'มี episode เพิ่มในงาน',
  'booking.notified_ready': 'ฟุตเทจพร้อมแล้ว',
  'booking.auto_notified_ready': 'ฟุตเทจพร้อมแล้ว',
  'booking.delivered': 'ส่งงานแล้ว',
  'booking.soft_delete': 'งานถูกลบ',
  'booking.undelete': 'งานถูกกู้คืน',
}

export const OWNER_OUTCOME_ACTIONS = Object.keys(OWNER_OUTCOME_LABELS)

export function isOwnerVisibleAction(action: string | null | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(OWNER_OUTCOME_LABELS, (action || '').trim())
}

/** ชื่อไทยของฟิลด์ที่ถูกแก้ — โชว์แค่ "ชื่อฟิลด์" ไม่โชว์ค่า (ปลอดภัยกว่าโดยไม่เสียประโยชน์) */
const FIELD_LABEL: Record<string, string> = {
  callTime: 'เวลาเริ่ม',
  estimatedWrap: 'เวลาเลิก',
  shootDate: 'วันถ่าย',
  shootEndDate: 'วันถ่ายวันสุดท้าย',
  shootType: 'รูปแบบถ่าย',
  locationName: 'สถานที่',
  status: 'สถานะ',
  assignedEmails: 'ทีมงาน',
  crewRequired: 'ตำแหน่งที่ขอ',
  cameraCount: 'จำนวนกล้อง',
  micCount: 'จำนวนไมค์',
  vanCount: 'รถตู้',
  producer: 'Producer',
  coProducer: 'Co-Producer',
  agencyRef: 'Product Code',
  notes: 'หมายเหตุ',
  adminNotes: 'โน้ตแอดมิน',
  specialEquipment: 'อุปกรณ์พิเศษ',
  equipmentNote: 'อุปกรณ์',
  rentalGearNote: 'ของเช่า',
  itinerary: 'กำหนดการ',
}

/**
 * บรรทัดรายละเอียดของ booking.update — "แก้: เวลาเริ่ม, สถานที่"
 *
 * เคสพิเศษ: cancelRequestedAt กลายเป็น null = แอดมินปฏิเสธคำขอยกเลิก (เก็บงานไว้)
 * ซึ่งเป็น feedback ที่เจ้าของงานรอฟังตรง ๆ ไม่ใช่ "แก้ฟิลด์"
 */
export function describeUpdate(changes: unknown): { title?: string; detail: string | null } {
  if (!changes || typeof changes !== 'object') return { detail: null }
  const keys = Object.keys(changes as Record<string, unknown>)
  if (keys.includes('cancelRequestedAt')) {
    const v = (changes as Record<string, any>).cancelRequestedAt
    // diffBooking เก็บเป็น { from, to } หรือค่าใหม่ตรง ๆ — รับทั้งสองแบบ
    const to = v && typeof v === 'object' && 'to' in v ? v.to : v
    if (to === null) return { title: 'คำขอยกเลิกถูกปฏิเสธ — เก็บงานไว้', detail: null }
  }
  const named = keys.map(k => FIELD_LABEL[k]).filter(Boolean)
  if (named.length === 0) return { detail: null }
  const shown = named.slice(0, 3).join(', ')
  return { detail: `แก้: ${shown}${named.length > 3 ? ` +${named.length - 3}` : ''}` }
}

/** เรียงตามกลุ่มความสำคัญก่อน แล้วใหม่สุดก่อนในกลุ่ม (at=null ไปท้ายกลุ่ม) */
export function sortItems(items: NotifItem[]): NotifItem[] {
  return [...items].sort((a, b) => {
    const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
    if (p !== 0) return p
    if (a.at === b.at) return 0
    if (a.at === null) return 1
    if (b.at === null) return -1
    return a.at < b.at ? 1 : -1
  })
}

/**
 * นับ "ยังไม่ได้ดู" = มีเวลาเกิด และเกิดหลังจากที่เปิดกระดิ่งครั้งล่าสุด
 *
 * ตั้งใจไม่นับ at=null (worker ที่ไม่เคย tick): มันเป็นสภาพค้าง ไม่ใช่ของใหม่ ถ้า
 * นับด้วย ตัวเลขจะติดค้างตลอดไปแล้วคนจะเลิกมองกระดิ่ง — ซึ่งคือโรคเดิมที่ทำให้
 * alert สีเขียวอยู่ 5 สัปดาห์แล้วไม่มีใครอ่าน. ของพวกนี้ยังอยู่ในลิสต์ให้เห็น
 */
export function countUnread(items: NotifItem[], seenAt: string | null): number {
  return items.filter(i => i.at !== null && (!seenAt || i.at > seenAt)).length
}


/**
 * ใครเห็นกลุ่มไหน — แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพราะนี่คือส่วนที่พลาดแล้วเจ็บ
 * (เทสได้โดยไม่ต้องมี DB และไม่ต้องปลอม session)
 *
 *   console      คิวยกเลิก + คิวแก้ไข — ADMIN/SUPPORT/MANAGER/COORDINATOR
 *                ทั้งหมดนี้เขาเปิด /admin เห็นอยู่แล้ว กระดิ่งไม่เปิดเผยอะไรใหม่
 *   systemErrors worker ค้าง — tier admin เท่านั้น (เรื่อง infra ไม่ใช่คิวงาน;
 *                coordinator ทำคิว ไม่ได้ดูแล container)
 *
 * "ผลงานของตัวเอง" ไม่มี scope เพราะทุกคนได้ แต่กรองด้วยความเป็นเจ้าของ + allowlist
 */
export interface NotifScopes { console: boolean; systemErrors: boolean }

export function notificationScopes(role: Role | string | null | undefined, position?: string | null): NotifScopes {
  return {
    console: hasConsoleAccess(role as Role),
    systemErrors: resolveTier(role as string, position ?? null) === 'admin',
  }
}
