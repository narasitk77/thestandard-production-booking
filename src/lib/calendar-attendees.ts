/**
 * v1.185 — แขกของ event ปฏิทินของ booking: **แหล่งความจริงที่เดียว**
 *
 * WHY THIS FILE EXISTS. ก่อนหน้านี้ลิสต์แขกถูกประกอบขึ้นใหม่แบบ inline อยู่ 4 ที่
 * (createCalendarEvent, admin assign route, calendar-reconcile 2 จุด) ด้วยตรรกะที่
 * ไม่เหมือนกันเป๊ะ ๆ ผลที่ตามมาซึ่งเจอจริงตอนไล่เคส "แก้วไม่มาในปฏิทิน":
 *
 *   1. `coProducerEmail` ไม่ได้อยู่ในลิสต์ของทุกที่ → Co-Producer ของงาน
 *      ไม่เคยได้ invite เลย แม้ชื่อจะอยู่บน booking มาตั้งแต่ v1.59
 *   2. การ์ด AGN-only ของ directorEmail (กฏ ops v1.146: "REMOVED in v1.143.1 —
 *      do not re-add without asking") มีอยู่ใน createCalendarEvent และ
 *      calendar-reconcile แต่ **ไม่มีใน assign route** → ทุกครั้งที่แอดมิน
 *      re-assign ครูงานที่ไม่ใช่ AGN ไดเรกเตอร์ถูกใส่กลับเข้าไปเงียบ ๆ
 *
 * ทุก path ที่แตะ attendee ต้องเรียกฟังก์ชันนี้ ห้ามประกอบลิสต์เองอีก
 */

export interface CalendarAttendeeInput {
  /** ทีมงานที่แอดมิน assign (id หลักของคนคืออีเมล) */
  assignedEmails?: string[] | null
  /** v1.131 — Producer ได้ invite ด้วย ไม่ใช่แค่ครู */
  producerEmail?: string | null
  /** v1.185 — Co-Producer ก็เป็นคนของงานเหมือนกัน (คำสั่ง operator 2026-08-21) */
  coProducerEmail?: string | null
  /** ไดเรกเตอร์ที่เลือกตอนจอง — **AGN เท่านั้น** ตามกฏ ops */
  directorEmail?: string | null
  /** v1.231 — ผู้กำกับคนที่ 2/3 (ไม่บังคับ) การ์ด AGN-only เดียวกันครอบทั้งสามคน */
  director2Email?: string | null
  director3Email?: string | null
  outletCode?: string | null
}

/**
 * ลิสต์แขกสุดท้าย: ทีมงาน + Producer + Co-Producer (+ Director ถ้าเป็น AGN)
 * dedupe แบบไม่สนตัวพิมพ์ และคงลำดับที่เจอครั้งแรกไว้ (ทีมงานมาก่อนเสมอ)
 */
// v1.270 — ค่าที่ไม่ใช่อีเมล ("tbc", ชื่อคน) ห้ามหลุดไปถึง Google: Calendar ตอบ
// "Invalid attendee email." แล้ว reconciler (10 นาที) ยิงซ้ำไม่รู้จบ — EVT-EVT-261104-01
// producerEmail="tbc" ล้ม 125 ครั้งใน 2 วัน (18–19 ต.ค. 2569) โดยไม่มีใครได้ invite เลย
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function bookingCalendarAttendees(input: CalendarAttendeeInput): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string | null | undefined) => {
    const email = (raw || '').trim()
    if (!email || !EMAIL_RE.test(email)) return
    const key = email.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(email)
  }

  for (const e of input.assignedEmails || []) add(typeof e === 'string' ? e : null)
  add(input.producerEmail)
  add(input.coProducerEmail)
  // AGN-only โดยเจตนา — ดูหัวไฟล์ ห้ามถอดการ์ดนี้ออกโดยไม่ถามฝ่าย ops
  // v1.231 — ผู้กำกับคนที่ 2/3 อยู่ใต้การ์ดเดียวกัน: เพิ่มคนได้ แต่กฏ AGN-only ไม่ขยับ
  if ((input.outletCode || '').trim().toUpperCase() === 'AGN') {
    add(input.directorEmail)
    add(input.director2Email)
    add(input.director3Email)
  }

  return out
}
