/**
 * v1.235 — ทำความสะอาดลิสต์อีเมลที่รับมาจาก client: ตัดช่องว่าง ทิ้งค่าว่าง ตัดซ้ำ
 *
 * WHY THIS FILE EXISTS. ตรรกะนี้เดิมเป็นฟังก์ชันท้องถิ่นใน assign route ที่เดียว
 * พอ create-booking ต้องรับ `assignedEmails` ด้วย (v1.235 — ฟอร์ม routine ตั้ง
 * ทีมงานประจำได้) ทางเลือกคือก๊อปไปอีกชุด ซึ่งเป็น bug class ข้อ 9 ของรีโปนี้เอง
 * (`one rule, N copies` — กฎเดียวกันหลายที่แล้วค่อย ๆ ไม่ตรงกัน) จึงยกออกมาไว้ที่เดียว
 *
 * **ไม่ lowercase** โดยตั้งใจ — ข้อมูลจริงบนพรอดมีทั้ง `sound@` และ `Sound@`
 * และ Google ก็มองเป็นคนเดียวกัน การบังคับ lowercase ตรงนี้จะทำให้ลิสต์ของใบเก่า
 * "เปลี่ยน" ทั้งที่ไม่มีใครแก้ ซึ่งไปโผล่เป็น diff ปลอมใน audit log
 */
export function cleanEmailList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const email = raw.trim()
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(email)
  }
  return out
}

/**
 * ตัดที่อยู่ผู้ส่งออกจากรายชื่อผู้รับ + ตัดตัวซ้ำ (lowercase — ใช้ตอนส่ง ไม่ใช่ตอนเก็บ)
 *
 * ไม่ใช่การขัดเงา: เมลที่ส่งจากบัญชี Gmail เดียวกับผู้รับจะหายเงียบ ฉะนั้นการปล่อย
 * ให้ผู้ส่งอยู่ในลิสต์ = สร้างผู้รับที่ไม่มีวันได้รับ แล้วบันทึกว่า "ส่งแล้ว"
 *
 * v1.248 — ย้ายมาจาก mix-notify.ts เพราะ notifyEmailDigest (notify.ts) ต้องใช้กฎเดียวกัน
 * (digest ของ ops ส่งหาบัญชี SMTP ตัวเองมาตลอด = ไม่มีใครได้รับ แต่คืน true)
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
