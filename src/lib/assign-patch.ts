/**
 * v1.235 — คิดว่าการ assign ครั้งนี้จะเขียนค่าอะไรลงใบจอง
 *
 * WHY THIS FILE EXISTS. `/api/admin/[id]/assign` เขียน `adminNotes`,
 * `freelancers` และ `mainVideographerEmail` ลง DB **ทุกครั้ง** โดยอ่านจาก body
 * ตรง ๆ ผู้เรียกแบบเต็มฟอร์มส่งครบทุกคีย์จึงไม่มีใครเห็นปัญหา แต่ปุ่ม
 * "เพิ่มทีมงานทั้งชุด" (v1.230) ส่งมาแค่ `{assignedEmails, sendEmail}`
 * ⇒ กดหนึ่งครั้ง = ล้างสามฟิลด์นั้นของทุกใบในชุด
 * (ตรวจพรอด 2026-09-24: ใบ routine ที่ยังอยู่มี adminNotes 38 ใบ · freelancers 27 ใบ)
 *
 * กฎคือ **คีย์ที่ไม่ได้ส่งมา = ไม่เปลี่ยน** ซึ่งเป็นกฎที่พังเงียบมาก
 * ถ้าอยู่ inline ในเราต์ที่ต้องต่อ DB ถึงจะเทสได้ จึงแยกออกมาเป็นฟังก์ชันบริสุทธิ์
 */
import { cleanEmailList } from './email-list'
import { normalizeFreelancers, freelancerEmails, type Freelancer } from './freelancers'

export interface AssignExisting {
  assignedEmails: string[]
  adminNotes: string | null
  mainVideographerEmail: string | null
  freelancers: unknown
}

export interface AssignPatch {
  emailRecipients: string[]
  freelancerList: Freelancer[]
  mainVideographerEmail: string | null
  adminNotes: string | null
}

export function resolveAssignPatch(body: Record<string, unknown> | null | undefined,
                                   existing: AssignExisting): AssignPatch {
  const b = body ?? {}
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k)

  // กฎ has() ต้องครอบ **ทุกฟิลด์** รวมถึงฟิลด์ที่เป็นชื่อ endpoint เอง
  // ไม่งั้น body ที่ไม่มีคีย์นี้ (เช่น {sendEmail:false} หรือ script ที่พิมพ์ชื่อคีย์ผิด)
  // จะล้างครูทั้งใบเป็น [] แล้ว patch แขกปฏิทินส่งใบยกเลิกให้ทุกคน โดยตอบ 200
  const staffEmails = has('assignedEmails')
    ? cleanEmailList(b.assignedEmails)
    : cleanEmailList(existing.assignedEmails)
  // ไม่ส่ง freelancers มา = ใช้ของเดิม — ไม่ใช่ [] เพราะ emailRecipients ประกอบจาก
  // ลิสต์นี้ด้วย ถ้ากลายเป็นว่าง ฟรีแลนซ์จะหลุดจากแขกปฏิทินไปพร้อมกัน
  // (patch แขกแทนที่ทั้งชุด — ใครหายจากลิสต์ได้ใบยกเลิก)
  const freelancerList = has('freelancers')
    ? normalizeFreelancers(b.freelancers)
    : normalizeFreelancers(existing.freelancers)
  // cleanEmailList ครอบผลรวม ไม่ใช่ Set ธรรมดา — ไม่งั้นกฎตัดซ้ำจะเป็นสองมาตรฐาน
  // ในฟังก์ชันเดียว (staff ตัดซ้ำไม่สนตัวพิมพ์ แต่ตอนผสมกับฟรีแลนซ์กลับสนตัวพิมพ์)
  const emailRecipients = cleanEmailList([...staffEmails, ...freelancerEmails(freelancerList)])

  // ช่างวิดีโอหลักต้องอยู่ในลิสต์ที่ assign จริงเสมอ — กฎเดิม ไม่เปลี่ยน
  const want = has('mainVideographerEmail') ? b.mainVideographerEmail : existing.mainVideographerEmail
  const mainVideographerEmail =
    typeof want === 'string' && want.trim() && emailRecipients.includes(want.trim())
      ? want.trim()
      : null

  const adminNotes = has('adminNotes')
    ? ((b.adminNotes as string) || null)
    : existing.adminNotes

  return { emailRecipients, freelancerList, mainVideographerEmail, adminNotes }
}
