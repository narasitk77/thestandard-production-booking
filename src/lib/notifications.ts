/**
 * v1.184 — สร้าง feed ของกระดิ่งแจ้งเตือนจาก **สถานะจริง** (ไม่มีตาราง notification)
 *
 * ฝั่งแอดมิน (ตามลำดับที่ operator สั่ง):
 *   1. ขอยกเลิก  — Booking.cancelRequestedAt (คอลัมน์เดียวกับแท็บ "ขอยกเลิก")
 *   2. ขอแก้ไข   — audit booking.time_change_request / booking.producer_update
 *                  ที่ /producer ยิงเข้ามา (ก่อน v1.184 เข้าแค่ audit + เมลกล่องเดียว
 *                  → ไม่มีที่ไหนบนจอเห็นเลย นี่คือช่องที่ปิด)
 *   3. error     — worker ค้าง/ไม่เคย tick จาก evaluateWorkers() ตัวเดียวกับ /admin/health
 *
 * ฝั่งเจ้าของงาน: ผลที่คนอื่นทำกับงานของตัวเอง (อนุมัติ/ปฏิเสธ/แก้เวลา/ฟุตเทจพร้อม)
 *
 * ขอบเขตการเห็น:
 *   - ขอยกเลิก + ขอแก้ไข → ใครมี console access (ADMIN/SUPPORT/MANAGER/COORDINATOR)
 *     ทั้งหมดนี้คือของที่เขาเปิด /admin เห็นอยู่แล้ว กระดิ่งไม่เปิดเผยอะไรใหม่
 *   - error ระบบ → tier admin เท่านั้น (เป็นเรื่อง infra ไม่ใช่คิวงาน)
 *   - ผลงานของตัวเอง → ทุกคน แต่เฉพาะงานที่ตัวเองเป็นเจ้าของ และเฉพาะ action ที่อยู่ใน
 *     allowlist (fail-closed) และ **ไม่ใช่สิ่งที่ตัวเองทำ** — ไม่ต้องเตือนเรื่องที่ตัวเองกด
 */
import { prisma } from './db'
import { evaluateWorkers } from './heartbeat'
import { type Role } from './roles'
import {
  type NotifItem, type NotifScopes, OWNER_OUTCOME_ACTIONS, OWNER_OUTCOME_LABELS,
  describeUpdate, sortItems, countUnread, notificationScopes,
} from './notification-kinds'

/** คิวแก้ไขไม่มีสถานะ "จัดการแล้ว" ใน DB — จำกัดด้วยเวลาแทน ไม่ให้ลิสต์ยาวไม่จบ */
const EDIT_REQUEST_WINDOW_DAYS = 14
const OWNER_WINDOW_DAYS = 30
const PER_GROUP_LIMIT = 15

const EDIT_REQUEST_ACTIONS = ['booking.time_change_request', 'booking.producer_update']

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000)
}

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null
}

export interface NotificationFeed {
  items: NotifItem[]
  unread: number
  seenAt: string | null
  scopes: NotifScopes
}

export async function buildNotificationFeed(session: { email: string; role: Role | string }): Promise<NotificationFeed> {
  const email = session.email.toLowerCase()
  // position ไม่ส่งเข้าไป: tier 'admin' ตัดสินจาก role ล้วน (ADMIN/SUPPORT/MANAGER)
  // position มีผลแค่กับ tier ที่ต่ำกว่า ซึ่งไม่ได้เห็น error ระบบอยู่แล้ว
  const scopes = notificationScopes(session.role)

  const seenRow = await prisma.notificationSeen.findUnique({ where: { email } })
  const seenAt = iso(seenRow?.at)

  const items: NotifItem[] = []

  if (scopes.console) {
    items.push(...(await cancelRequestItems()))
    items.push(...(await editRequestItems()))
  }
  if (scopes.systemErrors) {
    items.push(...(await systemErrorItems()))
  }
  items.push(...(await ownerOutcomeItems(email)))

  const sorted = sortItems(items)
  return {
    items: sorted,
    unread: countUnread(sorted, seenAt),
    seenAt,
    scopes,
  }
}

/** 1. ขอยกเลิก — สถานะจริงบน booking, ยังไม่ถูกยกเลิก = ยังต้องตัดสิน */
async function cancelRequestItems(): Promise<NotifItem[]> {
  const rows = await prisma.booking.findMany({
    where: { deletedAt: null, cancelRequestedAt: { not: null }, status: { not: 'CANCELLED' } },
    orderBy: { cancelRequestedAt: 'desc' },
    take: PER_GROUP_LIMIT,
    select: {
      id: true, bookingCode: true, cancelRequestedAt: true, cancelReason: true,
      cancelRequestedBy: true, shootDate: true,
      outlet: { select: { name: true } },
    },
  })
  return rows.map(b => ({
    id: `cancel:${b.id}:${b.cancelRequestedAt?.getTime()}`,
    kind: 'cancel_request' as const,
    at: iso(b.cancelRequestedAt),
    title: `ขอยกเลิก ${b.bookingCode || b.id}`,
    detail: [
      b.cancelReason?.trim() || 'ไม่ระบุเหตุผล',
      b.cancelRequestedBy ? `โดย ${b.cancelRequestedBy}` : null,
      `ถ่าย ${new Date(b.shootDate).toISOString().slice(0, 10)}`,
    ].filter(Boolean).join(' · '),
    href: `/admin/${b.id}`,
    code: b.bookingCode,
  }))
}

/** 2. ขอแก้ไข / อัปเดตจาก Producer — มีแต่ใน audit log (ไม่มี flag บน booking) */
async function editRequestItems(): Promise<NotifItem[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: 'Booking',
      action: { in: EDIT_REQUEST_ACTIONS },
      at: { gte: daysAgo(EDIT_REQUEST_WINDOW_DAYS) },
    },
    orderBy: { at: 'desc' },
    take: PER_GROUP_LIMIT,
    select: { id: true, at: true, action: true, actorEmail: true, entityId: true, bookingCode: true, changes: true },
  })
  return rows.map(r => {
    const ch = (r.changes || {}) as Record<string, any>
    const isTime = r.action === 'booking.time_change_request'
    return {
      id: `edit:${r.id}`,
      kind: 'edit_request' as const,
      at: iso(r.at),
      title: `${isTime ? 'ขอแก้เวลา' : 'อัปเดตจาก Producer'} ${r.bookingCode || ''}`.trim(),
      detail: [
        ch.requestedTime ? `เวลาที่ขอ ${ch.requestedTime}` : null,
        typeof ch.message === 'string' && ch.message.trim() ? ch.message.trim().slice(0, 140) : null,
        r.actorEmail ? `โดย ${r.actorEmail}` : null,
      ].filter(Boolean).join(' · ') || null,
      href: r.entityId ? `/admin/${r.entityId}` : '/admin',
      code: r.bookingCode,
    }
  })
}

/**
 * 3. error ระบบ — worker ค้าง / ไม่เคย tick
 *
 * `at` ของ "ค้าง" คือ **ช่วงเวลาที่มันกลายเป็นค้าง** (tick ล่าสุด + เกณฑ์) ไม่ใช่ now
 * ไม่งั้นทุกครั้งที่โหลดหน้าจะนับเป็นของใหม่ แล้วตัวเลขบนกระดิ่งจะไม่มีวันเป็น 0
 * ส่วน "ไม่เคย tick" ไม่มีจุดเริ่มที่วัดได้ → at=null (โชว์ แต่ไม่นับเป็นยังไม่ได้ดู)
 */
async function systemErrorItems(): Promise<NotifItem[]> {
  const workers = await evaluateWorkers()
  const bad = workers.filter(w => w.stale || w.neverTicked)
  return bad.map(w => {
    const staleSince = w.stale && w.lastTick
      ? new Date(new Date(w.lastTick).getTime() + w.intervalMs + 2 * 3_600_000).toISOString()
      : null
    return {
      id: `worker:${w.key}:${w.lastTick || 'never'}`,
      kind: 'system_error' as const,
      at: staleSince,
      title: `worker ไม่ตอบสนอง — ${w.label}`,
      detail: w.neverTicked
        ? 'เปิดใช้อยู่แต่ไม่เคยทำงานเลย — supervisor อาจไม่ได้รันสคริปต์'
        : `tick ล่าสุด ${w.ageMs != null ? Math.round(w.ageMs / 60_000) + ' นาทีที่แล้ว' : '—'}`,
      href: '/admin/health',
      code: null,
    }
  })
}

/**
 * 4. ผลที่เกิดกับงานของตัวเอง
 *
 * เจ้าของ = คนสร้าง (createdByEmail) หรือ Producer ของงาน (producerEmail) — เทียบ
 * แบบ case-insensitive เพราะ producerEmail ที่เก็บไว้อาจต่างตัวพิมพ์จาก session
 *
 * กัน leak สองชั้น: (ก) เฉพาะ booking ที่ตัวเองเป็นเจ้าของ (ข) เฉพาะ action ใน
 * allowlist ของ notification-kinds (fail-closed) และตัด action ที่ตัวเองเป็นคนทำออก
 */
async function ownerOutcomeItems(email: string): Promise<NotifItem[]> {
  const mine = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      OR: [
        { createdByEmail: { equals: email, mode: 'insensitive' } },
        { producerEmail: { equals: email, mode: 'insensitive' } },
      ],
    },
    orderBy: { shootDate: 'desc' },
    take: 300,
    select: { id: true },
  })
  if (mine.length === 0) return []

  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: 'Booking',
      entityId: { in: mine.map(b => b.id) },
      action: { in: OWNER_OUTCOME_ACTIONS },
      at: { gte: daysAgo(OWNER_WINDOW_DAYS) },
      // เรื่องที่ตัวเองกดเอง ไม่ต้องมาเตือนตัวเอง
      NOT: { actorEmail: { equals: email, mode: 'insensitive' } },
    },
    orderBy: { at: 'desc' },
    take: PER_GROUP_LIMIT,
    select: { id: true, at: true, action: true, entityId: true, bookingCode: true, changes: true, fromStatus: true, toStatus: true },
  })

  return rows.map(r => {
    let title = OWNER_OUTCOME_LABELS[r.action] || r.action
    let detail: string | null = null
    if (r.action === 'booking.update') {
      const d = describeUpdate(r.changes)
      if (d.title) title = d.title
      detail = d.detail
    } else if (r.action === 'booking.status_change' || r.action === 'booking.force_status') {
      detail = [r.fromStatus, r.toStatus].filter(Boolean).join(' → ') || null
    }
    return {
      id: `own:${r.id}`,
      kind: 'booking_outcome' as const,
      at: iso(r.at),
      title: `${title} ${r.bookingCode || ''}`.trim(),
      detail,
      href: r.entityId ? `/dashboard/${r.entityId}` : '/my-bookings',
      code: r.bookingCode,
    }
  })
}

/** บันทึกว่าเปิดกระดิ่งแล้ว — upsert เพื่อไม่ต้องมีแถวใน User ก่อน */
export async function markNotificationsSeen(email: string): Promise<string> {
  const at = new Date()
  const row = await prisma.notificationSeen.upsert({
    where: { email: email.toLowerCase() },
    update: { at },
    create: { email: email.toLowerCase(), at },
  })
  return row.at.toISOString()
}
