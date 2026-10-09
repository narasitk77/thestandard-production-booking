// v1.248 — เตือน ops ที่เดียว: worker ตาย · ซิงก์ปฏิทินมิกซ์ล้ม · ฟีเจอร์ใหม่ที่ต้องมีเสียงเมื่อพัง
//
// WHY THIS FILE EXISTS. เดิมทุกที่ที่ต้องเตือน ops เขียน throttle + ยิงช่องทางเอง (heartbeat.ts,
// mix-calendar route) และตรวจพรอด 29 ก.ย. 2569 พบว่า **ไม่มีช่องไหนถึงคนเลย**: Lark ไม่ได้ตั้ง ·
// Discord ทิ้ง 'ops' (ห้องทีมเป็น footage-only ตามที่ตกลงไว้)
// (v1.248 เคยเชื่อว่าเมล digest หาบัญชี SMTP ตัวเองไม่ถึงด้วย — ผิด: Gmail เอาเข้า Inbox · แก้ v1.262.2)
//
// ฟีเจอร์ใหม่ที่ต้องเตือนเมื่อพัง → `alertOps(key, subject, text)` อย่างเดียว ไม่ต้องเขียน throttle
// หรือเลือกช่องทางเอง · ช่องทางอยู่ใน notify.ts ที่เดียว (ห้อง Discord ops แยก
// `DISCORD_OPS_WEBHOOK_URL` · Lark · อีเมล digest) — เพิ่มช่องใหม่ที่นั่น ทุกผู้เรียกได้ด้วยกันหมด
//
// กฎ:
// - throttle ต่อ key (ค่าเริ่ม 6 ชม.) เก็บที่ system_heartbeats `alert:<key>` — key ของ stale-workers
//   เท่าเดิม throttle จึงต่อเนื่องข้าม deploy · ไม่มี schema ใหม่
// - ประทับเวลาเมื่อ **ลองส่งแล้ว** ไม่ใช่เมื่อส่งถึง: ช่วงที่ไม่มีช่องไหนตั้งไว้ dead-man (ทุก 10 นาที)
//   จะได้ไม่วนยิงและเขียน log ทุกรอบ · ผลจริงรายช่องอยู่ใน note ของแถว + ค่าที่คืน (ห้ามยุบเป็น boolean
//   เดียวแล้วเรียกว่า "ส่งแล้ว")
// - ส่งไม่ถึงช่องไหนเลย = console.error ดัง ๆ · ไม่ throw ไม่ว่ากรณีใด (การเตือนต้องไม่ล้มงานหลัก)
import { prisma } from './db'
import { notifyChatDetailed, notifyEmailDigest } from './notify'

export const OPS_ALERT_EVERY_MS = 6 * 3_600_000

export interface OpsAlertResult {
  /** ลองส่งรอบนี้ไหม (false = ยังอยู่ในหน้าต่าง throttle) */
  attempted: boolean
  /** ถึงอย่างน้อยหนึ่งช่อง */
  delivered: boolean
  discord: boolean
  lark: boolean
  email: boolean
}

export async function alertOps(key: string, subject: string, text: string, everyMs = OPS_ALERT_EVERY_MS): Promise<OpsAlertResult> {
  const stampKey = `alert:${key}`
  const none = { discord: false, lark: false, email: false }
  try {
    const last = (await prisma.systemHeartbeat.findUnique({ where: { key: stampKey } }))?.at
    if (last && Date.now() - last.getTime() < everyMs) return { attempted: false, delivered: false, ...none }
  } catch (e: any) {
    // อ่าน throttle ไม่ได้ → ส่ง (เตือนซ้ำดีกว่าเงียบ)
    console.warn(`[ops-alert] ${key}: อ่าน throttle ไม่ได้ — ส่งเลย:`, e?.message || e)
  }

  let channels = none
  try {
    const [chat, email] = await Promise.all([notifyChatDetailed(text, 'ops'), notifyEmailDigest(subject, text)])
    channels = { discord: chat.discord, lark: chat.lark, email }
  } catch (e: any) {
    console.error(`[ops-alert] ${key}: ส่งล้ม:`, e?.message || e)
  }
  const delivered = channels.discord || channels.lark || channels.email

  const at = new Date()
  const note = `discord=${channels.discord} lark=${channels.lark} email=${channels.email}`
  try {
    await prisma.systemHeartbeat.upsert({ where: { key: stampKey }, create: { key: stampKey, at, note }, update: { at, note } })
  } catch (e: any) {
    console.warn(`[ops-alert] ${key}: บันทึก throttle ไม่ได้:`, e?.message || e)
  }
  if (!delivered) {
    console.error(`[ops-alert] ${key}: เตือนไม่ถึงช่องไหนเลย — ตั้ง DISCORD_OPS_WEBHOOK_URL / LARK_WEBHOOK_URL`
      + ' / REMINDER_ADMIN_EMAIL หรือเช็ก SMTP · ข้อความ: ' + subject)
  }
  return { attempted: true, delivered, ...channels }
}
