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
// prod ส่งเมลผ่าน Gmail SMTP ด้วยบัญชี `narasit.k@` · dropSender() ตัดบัญชีผู้ส่งออกจากผู้รับ**ทุกฉบับ**ของคิวมิกซ์
// ด้วยเหตุผลว่า "Gmail ไม่ส่งเมลถึงตัวเอง" — ⚠️ เหตุผลนั้นผิด (ตรวจ 9 ต.ค. 2569: เมลหาตัวเองเข้า Inbox)
// ผลที่ยังเหลือ: ถ้า narasit.k@ เป็นคนขอ/คนรับงาน/ผู้ตัดสินเลื่อน จะไม่ได้เมลคิวมิกซ์ฉบับนั้น (พฤติกรรมเดิม ยังไม่ได้ถอด)

import { sendEmail, isEmailConfigured } from './email'
import { formatMixNumber } from './mix-jobs'
import { soundCoordinatorEmails } from './session'
import { dropSender } from './email-list'

/** กล่องกลางของทีมเสียง — ปลายทางหลักของคำขอใหม่ */
export function soundTeamEmail(): string {
  return (process.env.SOUND_TEAM_EMAIL?.trim() || 'sound@thestandard.co').toLowerCase()
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || '').replace(/\/+$/, '')
}

// v1.248 — dropSender ย้ายไป email-list.ts · export ต่อที่นี่ให้ผู้เรียกเดิมไม่ต้องแก้ (digest เลิกใช้แล้วตั้งแต่ v1.262.2)
export { dropSender }

export interface MixNotifyJob {
  number: number
  title: string
  bookingCode: string | null
  /** v1.244 — EP ID ของตอนที่ขอ (null = ทั้งใบ) */
  episodeCode?: string | null
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

function body(job: MixNotifyJob, lead: string, openPath = '/mix', extraLinks: string[] = []): string {
  const url = appUrl()
  return [
    lead,
    '',
    `${formatMixNumber(job.number)} — ${job.title}`,
    dueText(job.dueDate),
    job.bookingCode ? `ใบจอง: ${job.bookingCode}${job.episodeCode && job.episodeCode !== job.bookingCode ? ` · ตอน ${job.episodeCode}` : ''}` : null,
    `ผู้ขอ: ${job.requesterEmail}`,
    job.sourceLink ? `ไฟล์ต้นทาง: ${job.sourceLink}` : null,
    job.notes ? `โน้ต: ${job.notes}` : null,
    '',
    url ? `เปิดคิว: ${url}${openPath}` : null,
    ...(url ? extraLinks.map(l => l.replace('{url}', url)) : []),
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
      // v1.244 — ลิงก์พาไปแท็บ "คิว Mixing" ในหน้าแอดมินที่ Sound Admin แจกงาน (ไม่ใช่ /mix)
      // กล่องกลาง sound@ อ่านโดยวิศวกร tier crew ที่เปิด /admin ไม่ได้ → ให้ลิงก์ /mix คู่กัน
      text: body(job, 'มีคำขอมิกซ์เสียงเข้ามาใหม่ (Requested) — รอ Sound Admin แจกงาน', '/mix',
        ['แจกงาน (Sound Admin): {url}/admin?st=MIX']),
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
      // v1.244 — คนที่ถูกแจกอยู่ tier crew เปิด /admin ไม่ได้ ลิงก์ต้องพาไปที่ส่งงานได้จริง
      text: body(job, `${assignedBy} มอบหมายงานนี้ให้ ${assigneeEmail} (Assigned) — มิกซ์เสร็จแล้ววางลิงก์และกดส่งงานที่การ์ดนี้`, '/mix?scope=mine'),
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
        job.bookingCode ? `ใบจอง: ${job.bookingCode}${job.episodeCode && job.episodeCode !== job.bookingCode ? ` · ตอน ${job.episodeCode}` : ''}` : null,
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

/** v1.257 — ส่งเมลหนึ่งฉบับ คืนผลจริง (ใครได้รับ/ทำไมไม่ออก) · ไม่ throw: เมลล้มต้องไม่ย้อนการตัดสินใจที่บันทึกแล้ว */
async function sendMixMail(recipients: string[], subject: string, text: string, tag: string): Promise<MixNotifyResult> {
  const to = dropSender(recipients, process.env.SMTP_USER || process.env.EMAIL_FROM)
  if (to.length === 0) return { sent: false, to: [], reason: 'ไม่มีผู้รับที่ส่งถึงได้' }
  if (!isEmailConfigured()) return { sent: false, to, reason: 'ยังไม่ได้ตั้งค่าเมล' }
  try {
    await sendEmail({ to: to.join(','), subject, text })
    return { sent: true, to }
  } catch (e: any) {
    console.error(`[mix-notify] ${tag} failed:`, e?.message || e)
    return { sent: false, to, reason: e?.message || 'ส่งไม่สำเร็จ' }
  }
}

/**
 * v1.257 — คนถืองานขอเลื่อนกำหนดส่ง → **คนขอ + Producer ของใบ** (นัท: "แจ้งไปให้คนจองอนุมัติ")
 * · ลิงก์หลัก /mix (คิวปัจจุบันมีงาน IN_PROGRESS ทุกงาน) — /mix?scope=mine ไม่นับ Producer ของใบที่ไม่ได้ขอเอง
 * · /producer เป็นทางที่สองสำหรับ Producer (คนขอที่ไม่ใช่ Producer เปิดไม่ได้)
 */
export async function notifyMixPostponeRequested(
  job: MixNotifyJob,
  approvers: Array<string | null | undefined>,
  by: string,
  toDate: string,
  reason: string,
): Promise<MixNotifyResult> {
  // คนที่ขอเลื่อนอนุมัติตัวเองไม่ได้ (canDecideMixPostpone) → ส่งหาเขา = ไม่มีคนอนุมัติรู้ แต่การ์ดขึ้นว่าส่งแล้ว (ผู้ตรวจ v1.257)
  const to = approvers.filter((e): e is string => !!e && e.toLowerCase() !== by.toLowerCase())
  if (to.length === 0) return { sent: false, to: [], reason: 'ไม่มีคนขอ/Producer คนอื่นที่อนุมัติได้ — ให้แอดมินอนุมัติ' }
  return sendMixMail(
    to,
    `[คิวมิกซ์] ${formatMixNumber(job.number)} ขอเลื่อนกำหนดส่งเป็น ${toDate} — รอคุณอนุมัติ`,
    body(job, `${by} ขอเลื่อนกำหนดส่งเป็น ${toDate}\nเหตุผล: ${reason}\n\nกด "อนุมัติ" หรือ "ไม่อนุมัติ" ที่การ์ดของงานนี้`,
      '/mix', ['เมนู Producer: {url}/producer']),
    'postpone-requested',
  )
}

/** v1.257 — ตัดสินคำขอเลื่อนแล้ว → คนที่ขอเลื่อน (+ coordinator จะได้เห็นภาระที่เปลี่ยน) */
export async function notifyMixPostponeDecided(
  job: MixNotifyJob,
  requestedBy: string,
  by: string,
  approved: boolean,
  toDate: string,
): Promise<MixNotifyResult> {
  return sendMixMail(
    [requestedBy, ...soundCoordinatorEmails()],
    `[คิวมิกซ์] ${formatMixNumber(job.number)} ${approved ? `อนุมัติเลื่อนเป็น ${toDate}` : 'ไม่อนุมัติการขอเลื่อน'}`,
    body(job, approved
      ? `${by} อนุมัติให้เลื่อนกำหนดส่งเป็น ${toDate} แล้ว`
      : `${by} ไม่อนุมัติการขอเลื่อนเป็น ${toDate} — กำหนดส่งยังเป็นวันเดิม`, '/mix?scope=mine'),
    'postpone-decided',
  )
}
