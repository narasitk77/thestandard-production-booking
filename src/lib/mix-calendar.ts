// v1.245 — ซิงก์งานมิกซ์ → Google Calendar ปฏิทินแยก (ฝั่ง Google + DB)
//
// กฎทั้งหมดอยู่ใน mix-calendar-event.ts (บริสุทธิ์ + เทส) · ที่นี่แค่ทำตามแผน แล้วเขียนผลจริงลงแถว
//
// ไม่ throw ไม่ว่ากรณีใด: คำขอ/การแจก/การส่งงานต้องสำเร็จแม้ปฏิทินล่ม · แต่ **ไม่เงียบ** — ผลล้มถูกเก็บที่
// calendarSyncError ให้การ์ดโชว์ และคืนผลให้ route ใส่ใน audit (บทเรียน fire-and-forget ซ่อนความล้มเหลว)

import { google } from 'googleapis'
import { prisma } from './db'
import { getCalendarAuth, bookingCalendarIds } from './google-calendar'
import {
  mixCalendarTargetError, planMixCalendar, buildMixCalendarEvent, mixEventId,
  type MixCalendarJob, type MixCalendarPlan,
} from './mix-calendar-event'

/** เรียก Google แบบไม่ค้างนาน — คำขอ/แจก/ส่งงานรอผลนี้อยู่ (ล้มด้วย timeout = เก็บเป็น calendarSyncError) */
const GOOGLE_TIMEOUT = { timeout: 10_000 }

export function mixCalendarId(): string | null {
  return process.env.MIX_CALENDAR_ID?.trim() || null
}

export type MixCalendarResult =
  | { action: 'off' }
  | { action: MixCalendarPlan; ok: true; eventId: string | null }
  | { action: MixCalendarPlan | 'target'; ok: false; error: string }

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || '').replace(/\/+$/, '')
}

const statusOf = (e: any) => Number(e?.code ?? e?.response?.status ?? e?.status)
const gone = (e: any) => [404, 410].includes(statusOf(e))
const conflict = (e: any) => statusOf(e) === 409

/** ซิงก์งานเดียว · อ่านแถวล่าสุดจาก DB เอง (ผู้เรียกส่งแค่ id) จะได้ไม่ซิงก์จากค่าที่ค้างในหน่วยความจำ */
export async function syncMixJobCalendar(jobId: string): Promise<MixCalendarResult> {
  const calendarId = mixCalendarId()
  const target = mixCalendarTargetError(calendarId, bookingCalendarIds())
  if (target === 'off') return { action: 'off' }

  // DB อ่านไม่ได้ ≠ ไม่มีงาน (bug-class error ≠ ความว่างเปล่า) — สองอย่างนี้ต้องเล่าคนละเรื่องใน audit
  let job
  try {
    job = await prisma.mixJob.findUnique({ where: { id: jobId } })
  } catch (e: any) {
    return { action: 'none', ok: false, error: `อ่านงานจาก DB ไม่ได้: ${String(e?.message || e).slice(0, 200)}` }
  }
  if (!job) return { action: 'none', ok: false, error: 'ไม่พบงาน' }

  if (target) {
    await prisma.mixJob.update({ where: { id: job.id }, data: { calendarSyncError: target } }).catch(() => {})
    console.error(`[mix-calendar] ${target}`)
    return { action: 'target', ok: false, error: target }
  }

  const plan = planMixCalendar(job as MixCalendarJob)
  if (plan === 'none') {
    if (job.calendarSyncError) await prisma.mixJob.update({ where: { id: job.id }, data: { calendarSyncError: null } }).catch(() => {})
    return { action: 'none', ok: true, eventId: null }
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth: getCalendarAuth() })
    const cid = calendarId!
    // id คำนวณจาก id งาน: สร้างซ้ำไม่ได้ · ทั้ง create และ update ลงเอยที่ event ตัวเดียวกันเสมอ
    const id = job.calendarEventId || mixEventId(job.id)
    let eventId: string | null = id

    if (plan === 'delete') {
      try {
        await calendar.events.delete({ calendarId: cid, eventId: id, sendUpdates: 'none' }, GOOGLE_TIMEOUT)
      } catch (e) {
        if (!gone(e)) throw e // ลบไปแล้วจากฝั่ง Google = เป้าหมายสำเร็จอยู่แล้ว
      }
      eventId = null
    } else {
      const requestBody = buildMixCalendarEvent(job as MixCalendarJob, appUrl())
      const patch = () => calendar.events.patch({ calendarId: cid, eventId: id, sendUpdates: 'none', requestBody }, GOOGLE_TIMEOUT)
      const insert = () => calendar.events.insert({ calendarId: cid, sendUpdates: 'none', requestBody: { ...requestBody, id } }, GOOGLE_TIMEOUT)
      if (plan === 'update') {
        try {
          await patch()
        } catch (e) {
          // หายจากฝั่ง Google → สร้างใหม่ด้วย id เดิม (ชน 409 = มีคนสร้างไปแล้วพร้อมกัน → patch)
          if (!gone(e)) throw e
          try { await insert() } catch (e2) { if (!conflict(e2)) throw e2; await patch() }
        }
      } else {
        // มีอยู่แล้ว (รอบก่อน insert สำเร็จแต่บันทึกไม่ทัน / สองคำขอพร้อมกัน / เคยลบแล้วกลับมา) → 409 → patch
        try { await insert() } catch (e) { if (!conflict(e)) throw e; await patch() }
      }
    }

    await prisma.mixJob.update({ where: { id: job.id }, data: { calendarEventId: eventId, calendarSyncError: null } })
    return { action: plan, ok: true, eventId }
  } catch (e: any) {
    const error = String(e?.message || e).slice(0, 500)
    console.error(`[mix-calendar] ${plan} ${job.id} failed:`, error)
    await prisma.mixJob.update({ where: { id: job.id }, data: { calendarSyncError: error } }).catch(() => {})
    return { action: plan, ok: false, error }
  }
}

/** สรุปผลใส่ audit — สั้นพอให้อ่านในประวัติ ไม่ใช่ทั้งก้อน */
export function mixCalendarAuditNote(r: MixCalendarResult): Record<string, unknown> {
  if (r.action === 'off') return {}
  return r.ok ? { calendar: r.action } : { calendar: r.action, calendarError: r.error }
}
