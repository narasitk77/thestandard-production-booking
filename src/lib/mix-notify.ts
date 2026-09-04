// v1.216 — แจ้งเตือนของคิวมิกซ์
//
// เส้นทางที่ operator ออกแบบไว้ (2026-09-03):
//   1. คนขอส่งคำขอ พร้อมกำหนดส่ง
//   2. **แจ้งไปที่ sound@thestandard.co**
//   3. **coordinator (krittapon.j@) ได้รับแจ้ง แล้วแจกให้ทีมงาน**
//   4. ถูกบันทึกไว้ในระบบ
//
// ─── ทำไมต้องมีไฟล์นี้ ─────────────────────────────────────────────────────────
// v1.215 ปล่อยคิวออกไปโดย **ไม่มีการแจ้งเตือนเลยสักบรรทัด** ทีมเสียงต้องเปิดหน้า
// เองถึงจะรู้ว่ามีงาน ซึ่งเป็นความล้มเหลวแบบเดียวกับ /switcher แต่กลับด้าน: ที่นั่น
// ไม่มีคน "กรอก" ที่นี่ไม่มีคน "อ่าน" — ผลปลายทางเหมือนกันคือทุกคนกลับไปทักในแชท
//
// ⚠️ กับดักที่เช็คแล้วว่าไม่โดน (แต่ห้ามลืม): prod ส่งเมลผ่าน Gmail SMTP ด้วยบัญชี
// `narasit.k@` — Gmail **ไม่ส่งเมลถึงตัวเอง** ฉะนั้นถ้าใส่ที่อยู่ผู้ส่งเป็นผู้รับ
// เมลจะหายเงียบโดยไม่มี error (นี่คือสาเหตุจริงที่ footage-ready "ส่งสำเร็จ" 103 ครั้ง
// โดยไม่มีใครได้รับ 5 สัปดาห์) · ปลายทางของเราคือ sound@ กับ krittapon.j@ ซึ่งเป็น
// คนละที่อยู่กับผู้ส่ง จึงผ่าน — dropSender() ข้างล่างกันไว้อีกชั้นเผื่อวันหนึ่ง
// มีคนตั้ง SOUND_TEAM_EMAIL เป็นที่อยู่เดียวกับผู้ส่ง

import { sendEmail, isEmailConfigured } from './email'
import { formatMixNumber } from './mix-jobs'
import { soundCoordinatorEmails } from './session'

/** กล่องกลางของทีมเสียง — ปลายทางหลักของคำขอใหม่ */
export function soundTeamEmail(): string {
  return (process.env.SOUND_TEAM_EMAIL?.trim() || 'sound@thestandard.co').toLowerCase()
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || '').replace(/\/+$/, '')
}

/**
 * ตัดที่อยู่ผู้ส่งออกจากรายชื่อผู้รับ + ตัดตัวซ้ำ
 *
 * ไม่ใช่การขัดเงา: เมลที่ส่งจากบัญชี Gmail เดียวกับผู้รับจะหายเงียบ ฉะนั้นการปล่อย
 * ให้ผู้ส่งอยู่ในลิสต์ = สร้างผู้รับที่ไม่มีวันได้รับ แล้วบันทึกว่า "ส่งแล้ว"
 */
export function dropSender(recipients: string[], sender: string | undefined): string[] {
  const from = (sender || '').toLowerCase().replace(/^.*<|>.*$/g, '').trim()
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of recipients) {
    const e = r.trim().toLowerCase()
    if (!e || e === from || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

export interface MixNotifyJob {
  number: number
  title: string
  bookingCode: string | null
  dueDate: Date | string | null
  requesterEmail: string
  sourceLink: string | null
  deliveryLink?: string | null
  notes: string | null
}

function dueText(due: Date | string | null): string {
  if (!due) return 'ไม่ได้ระบุกำหนดส่ง'
  const s = typeof due === 'string' ? due : due.toISOString()
  return `ต้องการภายใน ${s.slice(0, 10)}`
}

function body(job: MixNotifyJob, lead: string): string {
  const url = appUrl()
  return [
    lead,
    '',
    `${formatMixNumber(job.number)} — ${job.title}`,
    dueText(job.dueDate),
    job.bookingCode ? `ใบจอง: ${job.bookingCode}` : null,
    `ผู้ขอ: ${job.requesterEmail}`,
    job.sourceLink ? `ไฟล์ต้นทาง: ${job.sourceLink}` : null,
    job.notes ? `โน้ต: ${job.notes}` : null,
    '',
    url ? `เปิดคิว: ${url}/mix` : null,
  ].filter(Boolean).join('\n')
}

export type MixNotifyResult = { sent: boolean; to: string[]; reason?: string }

/**
 * คำขอใหม่ → กล่องกลางทีมเสียง + coordinator
 *
 * คืนค่าเป็นผลจริง ไม่ใช่ boolean เดียว: คนอ่านต้องรู้ว่า **ใครได้รับ** ไม่ใช่แค่
 * "ยิงไปแล้ว" (บทเรียน v1.186 — บันทึกว่าส่งถึง 85/85 คนทั้งที่ไม่มีใครได้รับ)
 * ไม่ throw ไม่ว่ากรณีใด: การแจ้งเตือนล้มต้องไม่ทำให้คำขอที่คนตั้งใจส่งหายไปด้วย
 */
export async function notifyMixRequested(job: MixNotifyJob): Promise<MixNotifyResult> {
  const to = dropSender(
    [soundTeamEmail(), ...soundCoordinatorEmails()],
    process.env.SMTP_USER || process.env.EMAIL_FROM,
  )
  if (to.length === 0) return { sent: false, to: [], reason: 'ไม่มีผู้รับที่ส่งถึงได้' }
  if (!isEmailConfigured()) return { sent: false, to, reason: 'ยังไม่ได้ตั้งค่าเมล' }
  try {
    await sendEmail({
      to: to.join(','),
      subject: `[คิวมิกซ์] ${formatMixNumber(job.number)} ${job.title}`,
      text: body(job, 'มีคำขอมิกซ์เสียงเข้ามาใหม่ — รอ coordinator แจกงาน'),
    })
    return { sent: true, to }
  } catch (e: any) {
    console.error('[mix-notify] requested failed:', e?.message || e)
    return { sent: false, to, reason: e?.message || 'ส่งไม่สำเร็จ' }
  }
}

/**
 * แจกงานแล้ว → คนที่ถูกแจก (+ คนขอ จะได้รู้ว่างานเดินแล้ว)
 *
 * คนขอถูกใส่ไว้ด้วยโดยตั้งใจ: ปลายทางของคิวคือคนขอเลิกต้องเดินไปถามในแชท ถ้าแจ้ง
 * แต่คนทำ คนขอก็ยังต้องไปถามอยู่ดี แล้วคิวก็แก้ปัญหาได้แค่ครึ่งเดียว
 */
export async function notifyMixAssigned(
  job: MixNotifyJob,
  assigneeEmail: string,
  assignedBy: string,
): Promise<MixNotifyResult> {
  const to = dropSender(
    [assigneeEmail, job.requesterEmail],
    process.env.SMTP_USER || process.env.EMAIL_FROM,
  )
  if (to.length === 0) return { sent: false, to: [], reason: 'ไม่มีผู้รับที่ส่งถึงได้' }
  if (!isEmailConfigured()) return { sent: false, to, reason: 'ยังไม่ได้ตั้งค่าเมล' }
  try {
    await sendEmail({
      to: to.join(','),
      subject: `[คิวมิกซ์] ${formatMixNumber(job.number)} มอบหมายให้ ${assigneeEmail.split('@')[0]}`,
      text: body(job, `${assignedBy} มอบหมายงานนี้ให้ ${assigneeEmail}`),
    })
    return { sent: true, to }
  } catch (e: any) {
    console.error('[mix-notify] assigned failed:', e?.message || e)
    return { sent: false, to, reason: e?.message || 'ส่งไม่สำเร็จ' }
  }
}


/**
 * v1.217 — ส่งงานแล้ว → **คนขอ** (+ coordinator จะได้เห็นว่าคิวเดินจบ)
 *
 * นี่คือขาที่หายไปตั้งแต่ v1.215: คนขอไม่เคยรู้ว่างานเสร็จ ต้องกลับมาเปิดหน้าเอง
 * หรือไปถามในแชท · เมลฉบับนี้มีลิงก์ไฟล์อยู่ในตัว จึงเป็นจุดที่วงจรปิดจริง —
 * คนขอไม่ต้องถามใครอีก
 */
export async function notifyMixDelivered(
  job: MixNotifyJob,
  deliveryLink: string,
  by: string,
): Promise<MixNotifyResult> {
  const to = dropSender(
    [job.requesterEmail, ...soundCoordinatorEmails()],
    process.env.SMTP_USER || process.env.EMAIL_FROM,
  )
  if (to.length === 0) return { sent: false, to: [], reason: 'ไม่มีผู้รับที่ส่งถึงได้' }
  if (!isEmailConfigured()) return { sent: false, to, reason: 'ยังไม่ได้ตั้งค่าเมล' }
  try {
    await sendEmail({
      to: to.join(','),
      subject: `[คิวมิกซ์] ${formatMixNumber(job.number)} ส่งงานแล้ว — ${job.title}`,
      text: [
        `${by} มิกซ์เสร็จแล้ว`,
        '',
        `${formatMixNumber(job.number)} — ${job.title}`,
        job.bookingCode ? `ใบจอง: ${job.bookingCode}` : null,
        '',
        `ไฟล์ที่มิกซ์แล้ว: ${deliveryLink}`,
        '',
        appUrl() ? `เปิดคิว: ${appUrl()}/mix` : null,
      ].filter(Boolean).join('\n'),
    })
    return { sent: true, to }
  } catch (e: any) {
    console.error('[mix-notify] delivered failed:', e?.message || e)
    return { sent: false, to, reason: e?.message || 'ส่งไม่สำเร็จ' }
  }
}
